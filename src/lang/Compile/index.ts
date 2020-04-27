import * as Immutable from 'immutable';
import React from 'react';

import Signal from '../../util/Signal';
import Trace from '../../util/Trace';
import { diffMap } from '../../util/immutable/Map';
import { bug } from '../../util/bug';
import Type from '../Type';
import * as Render from '../Render';
import * as data from '../../data';

import compileFile from './compileFile';
import compileNote from './compileNote';
import findImports from './findImports';
import groupFilesByTag from './groupFilesByTag';
import groupFilesByTag2 from './groupFilesByTag2';
import noteOfGroup from './noteOfGroup';
import parseNote from './parseNote';

const debug = false;

// TODO(jaked) called from app, where should this go?
export function notesOfFiles(
  trace: Trace,
  files: Signal<data.Files>,
): Signal<data.Notes> {
  const groupedFiles =
    Signal.label('groupedFiles',
      Signal.mapWithPrev(
        files,
        groupFilesByTag,
        Immutable.Map(),
        Immutable.Map()
      )
    );
  return Signal.label('notesOfFiles',
    Signal.mapImmutableMap(groupedFiles, noteOfGroup)
  );
}

function sortNotes(noteImports: Immutable.Map<string, Immutable.Set<string>>): Immutable.List<string> {
  const sortedTags = Immutable.List<string>().asMutable();
  const remaining = new Set(noteImports.keys());
  let again = true;
  while (again) {
    again = false;
    remaining.forEach(tag => {
      const imports = noteImports.get(tag) ?? bug(`expected imports for ${tag}`);
      if (imports.size === 0) {
        sortedTags.push(tag);
        remaining.delete(tag);
        again = true;
      } else {
        if (debug) console.log('imports for ' + tag + ' are ' + imports.join(' '));
        if (imports.every(tag => !remaining.has(tag))) {
          if (debug) console.log('adding ' + tag + ' to order');
          sortedTags.push(tag);
          remaining.delete(tag);
          again = true;
        }
      }
    });
  }
  // any remaining notes can't be parsed, or are part of a dependency loop
  remaining.forEach(tag => {
    if (debug) console.log(tag + ' failed to parse or has a loop');
    sortedTags.push(tag)
  });
  return sortedTags.asImmutable();
}

// dirty notes that import a dirty note (post-sorting for transitivity)
// TODO(jaked)
// don't need to re-typecheck / re-compile a note if it hasn't changed
// and its dependencies haven't changed their types
function dirtyTransitively(
  orderedTags: Immutable.List<string>,
  compiledNotes: data.CompiledNotes,
  noteImports: Immutable.Map<string, Immutable.Set<string>>
): data.CompiledNotes {
  const dirty = new Set<string>();
  orderedTags.forEach(tag => {
    if (!compiledNotes.has(tag)) {
      if (debug) console.log(tag + ' dirty because file changed');
      dirty.add(tag);
    }
    const imports = noteImports.get(tag) ?? bug(`expected imports for ${tag}`);
    if (debug) console.log('imports for ' + tag + ' are ' + imports.join(' '));
    // a note importing a dirty note must be re-typechecked
    if (!dirty.has(tag) && imports.some(tag => dirty.has(tag))) {
      const dirtyTag = imports.find(tag => dirty.has(tag));
      if (debug) console.log(tag + ' dirty because ' + dirtyTag);
      dirty.add(tag);
      compiledNotes.delete(tag);
    }
  });
  return compiledNotes;
}

function compileDirtyNotes(
  trace: Trace,
  orderedTags: Immutable.List<string>,
  parsedNotes: data.ParsedNotesWithImports,
  compiledNotes: data.CompiledNotes,
  updateFile: (path: string, buffer: Buffer) => void,
  setSelected: (note: string) => void,
): data.CompiledNotes {
  const typeEnv = Render.initTypeEnv;
  const valueEnv = Render.initValueEnv(setSelected);
  orderedTags.forEach(tag => {
    const compiledNote = compiledNotes.get(tag);
    if (!compiledNote) {
      const parsedNote = parsedNotes.get(tag) ?? bug(`expected note for ${tag}`);
      if (debug) console.log('typechecking / rendering ' + tag);

      const noteEnv = parsedNote.imports.map(imports => {
        const modules = Immutable.Map<string, data.CompiledNote>().asMutable();
        imports.forEach(tag => {
          const note = compiledNotes.get(tag);
          if (note) modules.set(tag, note);
        });
        return modules.asImmutable();
      });

      const compiledNote =
        trace.time(tag, () =>
          compileNote(
            trace,
            parsedNote,
            typeEnv,
            valueEnv,
            noteEnv,
            updateFile,
            setSelected
          )
        );
      compiledNotes = compiledNotes.set(tag, compiledNote);
    }
  });
  return compiledNotes;
}

export function compileNotes(
  trace: Trace,
  notesSignal: Signal<data.Notes>,
  updateFile: (path: string, buffer: Buffer) => void,
  setSelected: (note: string) => void,
): Signal<data.CompiledNotes> {
  const parsedNotesSignal = Signal.label('parseNotes',
    Signal.mapImmutableMap(
      notesSignal,
      note => parseNote(trace, note)
    )
  );

  // TODO(jaked) consolidate with prev mapImmutableMap?
  const parsedNotesWithImportsSignal = Signal.label('parseNotesWithImports',
    Signal.mapImmutableMap(
      parsedNotesSignal,
      (v, k, parsedNotes) => findImports(v, parsedNotes)
    )
  );

  const noteImportsSignal = Signal.label('noteImports',
    Signal.joinImmutableMap(
      Signal.mapImmutableMap(
        parsedNotesWithImportsSignal,
        note => note.imports
      )
    )
  );

  // TODO(jaked)
  // maybe could do this with more fine-grained Signals
  // but it's easier to do all together
  return Signal.label('compileNotes',
    Signal.mapWithPrev<[data.ParsedNotesWithImports, Immutable.Map<string, Immutable.Set<string>>], data.CompiledNotes>(
      Signal.join(parsedNotesWithImportsSignal, noteImportsSignal),
      ([parsedNotes, imports], [prevParsedNotes, prevImports], prevCompiledNotes) => {
        const compiledNotes = prevCompiledNotes.asMutable();
        const parsedNotesDiff = diffMap(prevParsedNotes, parsedNotes);
        const importsDiff = diffMap(prevImports, imports);

        parsedNotesDiff.deleted.forEach((v, tag) => compiledNotes.delete(tag));
        parsedNotesDiff.changed.forEach((v, tag) => compiledNotes.delete(tag));
        importsDiff.deleted.forEach((v, tag) => compiledNotes.delete(tag));
        importsDiff.changed.forEach((v, tag) => compiledNotes.delete(tag));

        // topologically sort notes according to imports
        const orderedTags = trace.time('sortNotes', () => sortNotes(imports));

        // dirty notes that import a dirty note (post-sorting for transitivity)
        trace.time('dirtyTransitively', () => dirtyTransitively(orderedTags, compiledNotes, imports));

        // compile dirty notes (post-sorting for dependency ordering)
        trace.time('compileDirtyNotes', () => compileDirtyNotes(trace, orderedTags, parsedNotes, compiledNotes, updateFile, setSelected));
        return compiledNotes.asImmutable();
      },
      [Immutable.Map(), Immutable.Map()],
      Immutable.Map()
    )
  );
}

const unimplementedSignal = Signal.err(new Error('unimplemented'));

export function compileFiles(
  trace: Trace,
  files: Signal<data.Files>,
  updateFile: (path: string, buffer: Buffer) => void,
  setSelected: (note: string) => void,
): { compiledFiles: Signal<Immutable.Map<string, Signal<data.CompiledFile>>>, compiledNotes: Signal<data.CompiledNotes> } {

  // TODO(jaked)
  // * map a file compilation function over files
  // * collect note list from file list, map a note compilation function over notes
  // * these compilations are lazy, demanded at the top level by mainSignal
  // * compilation functions refer to other files / notes via Signal ref
  //   - Signal ref can be set after creation, maintain increasing version
  //   - Signal loop breaker to avoid infinite loop

  const filesByTag = groupFilesByTag2(files);

  const compiledFilesRef = Signal.ref<Immutable.Map<string, Signal<data.CompiledFile>>>();

  const compiledNotesRef = Signal.ref<data.CompiledNotes>();

  const compiledFiles = Signal.mapImmutableMap(files, file =>
    compileFile(trace, file, compiledFilesRef, compiledNotesRef, updateFile, setSelected)
  );
  compiledFilesRef.set(compiledFiles);

  const compiledNotes: Signal<data.CompiledNotes> = Signal.mapImmutableMap(filesByTag, (files, tag) => {
    function compiledFileForType(type: data.Types): Signal<data.CompiledFile | undefined> {
      // TODO(jaked) fix tags for index files, then just use tag here instead of files
      const file = files.find(file => file.type === type);
      if (file) {
        return compiledFiles.flatMap(compiledFiles =>
          compiledFiles.get(file.path) ?? Signal.ok(undefined)
        );
      } else {
        return Signal.ok(undefined);
      }
    }

    // TODO(jaked) Signal.untuple
    const parts =
      Signal.join(
        compiledFileForType('meta'),
        compiledFileForType('mdx'),
        compiledFileForType('table'),
        compiledFileForType('json'),
      ).map(([meta, mdx, table, json]) => {
        let rendered: Signal<React.ReactNode>;
        if (mdx) rendered = mdx.rendered;
        else if (table) rendered = table.rendered;
        else if (json) rendered = json.rendered;
        else if (meta) rendered = meta.rendered;
        else bug(`expected compiled file for '${tag}'`);

        const problems =
          (mdx ? mdx.problems : false) ||
          (table ? table.problems : false) ||
          (json ? json.problems : false) ||
          (meta ? meta.problems : false);

        // TODO(jaked) merge exportType / exportValue across files
        let exportType: Type.ModuleType;
        if (mdx) exportType = mdx.exportType;
        else if (table) exportType = table.exportType;
        else if (json) exportType = json.exportType;
        else if (meta) exportType = meta.exportType;
        else bug(`expected compiled file for '${tag}'`);
        let exportValue: { [s: string]: Signal<any> };
        if (mdx) exportValue = mdx.exportValue;
        else if (table) exportValue = table.exportValue;
        else if (json) exportValue = json.exportValue;
        else if (meta) exportValue = meta.exportValue;
        else bug(`expected compiled file for '${tag}'`);

        return {
          problems,
          rendered,
          exportType,
          exportValue,
        };
      });
      return {
        tag,
        isIndex: false,
        meta: unimplementedSignal,
        files: { },
        parsed: { },
        imports: unimplementedSignal,
        compiled: { },
        problems: parts.map(parts => parts.problems),
        rendered: parts.flatMap(parts => parts.rendered),
        exportType: parts.map(parts => parts.exportType),
        exportValue: parts.map(parts => parts.exportValue),
      };
  });
  compiledNotesRef.set(compiledNotes);

  return { compiledFiles, compiledNotes };
}
