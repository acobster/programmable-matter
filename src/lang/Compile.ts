import * as Path from 'path';

import * as Immutable from 'immutable';

import * as React from 'react';
import 'regenerator-runtime/runtime'; // required for react-inspector
import { Inspector } from 'react-inspector';

import Signal from '../util/Signal';
import Trace from '../util/Trace';
import Try from '../util/Try';
import * as data from '../data';
import * as MDXHAST from './mdxhast';
import * as ESTree from './ESTree';
import * as Parser from './Parser';
import Type from './Type';
import Typecheck from './Typecheck';
import * as Evaluator from './Evaluator';
import * as Render from './Render';
import * as String from '../util/String';
import { diffMap } from '../util/immutable/Map';
import { bug } from '../util/bug';

const debug = false;

export type ModuleValueEnv = Immutable.Map<string, { [s: string]: Signal<any> }>

function sanitizeMeta(obj: any): data.Meta {
  // TODO(jaked) json-schema instead of hand-coding this?
  // TODO(jaked) report errors somehow
  const type =
    (obj.type === 'mdx' || obj.type === 'json' || obj.type === 'txt') ?
    { type: obj.type } : {};

  const title =
    typeof obj.title === 'string' ?
    { title: obj.title } : {};

  const tags =
    (Array.isArray(obj.tags) && obj.tags.every(s => typeof s === 'string')) ?
    { tags: obj.tags } : {};

  const layout =
    typeof obj.layout === 'string' ?
    { layout: obj.layout } : {};

  return { ...type, ...title, ...tags, ...layout };
}

function tagOfPath(path: string) {
  const pathParts = Path.parse(path);
  return Path.join(pathParts.dir, pathParts.name);
}

function isDotMeta(path: string) {
  const pathParts = Path.parse(path);
  return pathParts.base === '.meta';
}

function isDotMetaForTag(path, tag) {
  const pathParts = Path.parse(path);
  const is = pathParts.base === '.meta' && !Path.relative(pathParts.dir, tag).startsWith('..');
  if (debug) console.log(`isDotMetaForTag(${path}, ${tag}) = ${is}`)
  return is;
}

function groupFilesByTag(
  files: data.Files,
  oldFiles: data.Files,
  oldGroupedFiles: Immutable.Map<string, Immutable.Map<string, Signal<data.File>>>
): Immutable.Map<string, Immutable.Map<string, Signal<data.File>>> {

  // TODO(jaked)
  // seems like we could extract an abstraction here to Signal
  // i.e. an incrementally-maintained view of a join, somehow

  let groupedFiles = oldGroupedFiles;
  const { added, changed, deleted } = diffMap(oldFiles, files);

  // first, handle updates of non-.meta files, so groupedFiles has correct tags
  deleted.forEach(path => {
    if (debug) console.log(`${path} deleted`);
    if (!isDotMeta(path)) {
      const tag = tagOfPath(path);
      const group = groupedFiles.get(tag) || bug(`expected group for ${tag}`);
      groupedFiles = groupedFiles.set(tag, group.delete(path));
    }
  });

  changed.forEach(([prev, curr], path) => {
    // TODO(jaked) can this ever happen for Filesystem?
    if (debug) console.log(`${path} signal changed`);
    if (!isDotMeta(path)) {
      const tag = tagOfPath(path);
      const group = groupedFiles.get(tag) || bug(`expected group for ${tag}`);
      groupedFiles = groupedFiles.set(tag, group.set(path, curr));
    }
  });

  added.forEach((v, path) => {
    if (debug) console.log(`${path} added`);
    if (!isDotMeta(path)) {
      const tag = tagOfPath(path);
      const group = groupedFiles.get(tag) || Immutable.Map();
      groupedFiles = groupedFiles.set(tag, group.set(path, v));
    }
  });

  // next, update join for changed .meta files
  groupedFiles = groupedFiles.map((group, tag) => {
    deleted.forEach(path => {
      if (isDotMetaForTag(path, tag)) {
        group = group.delete(path);
      }
    });

    changed.forEach(([prev, curr], path) => {
      // TODO(jaked) can this ever happen for Filesystem?
      if (isDotMetaForTag(path, tag)) {
        group = group.set(path, curr);
      }
    });

    added.forEach((v, path) => {
      if (isDotMetaForTag(path, tag)) {
        group = group.set(path, v);
      }
    });

    return group;
  });

  // finally, update join for changed non-.meta files
  files.forEach((file, path) => {
    if (isDotMeta(path)) {
      const metaPath = path;

      deleted.forEach(path => {
        if (!isDotMeta(path)) {
          const tag = tagOfPath(path);
          if (isDotMetaForTag(metaPath, tag)) {
            const group = groupedFiles.get(tag) || bug(`expected group for ${tag}`);
            groupedFiles = groupedFiles.set(tag, group.delete(metaPath));
          }
        }
      });

      changed.forEach((_, path) => {
        // TODO(jaked) can this ever happen for Filesystem?
        if (!isDotMeta(path)) {
          const tag = tagOfPath(path);
          if (isDotMetaForTag(metaPath, tag)) {
            const group = groupedFiles.get(tag) || bug(`expected group for ${tag}`);
            groupedFiles = groupedFiles.set(tag, group.set(metaPath, file));
          }
        }
      });

      added.forEach((_, path) => {
        if (!isDotMeta(path)) {
          const tag = tagOfPath(path);
          if (isDotMetaForTag(metaPath, tag)) {
            const group = groupedFiles.get(tag) || bug(`expected group for ${tag}`);
            groupedFiles = groupedFiles.set(tag, group.set(metaPath, file));
          }
        }
      });
    }
  })

  groupedFiles =
    groupedFiles.filterNot(group => group.every((_, path) => isDotMeta(path) || Path.parse(path).ext === '.meta'));

  return groupedFiles;
}

function typeOfPath(path: string): data.Types {
  const pathParts = Path.parse(path);

  let type: undefined | data.Types = undefined;
  if (pathParts.ext) {
    switch (pathParts.ext) {
      case '.md': type = 'mdx'; break; // TODO(jaked) support MD without X
      case '.mdx': type = 'mdx'; break;
      case '.json': type = 'json'; break;
      case '.txt': type = 'txt'; break;
      case '.JPG': type = 'jpeg'; break;
      case '.jpg': type = 'jpeg'; break;
      case '.jpeg': type = 'jpeg'; break;
      default:
        // TODO(jaked) throwing here fails the whole UI
        // need to encode the error in Note somehow
        // or avoid joining the map values
        console.log(`unhandled extension '${pathParts.ext}' for '${path}'`);
    }
  }
  if (!type) type = 'mdx';
  return type;
}

function noteOfGroup(
  group: Immutable.Map<string, Signal<data.File>>,
  tag: string
): Signal<data.Note> {
  let metaFiles: Signal<data.File>[] = [];

  const dirMetas =
    group.filter((_, path) => isDotMeta(path)).sortBy((_, path) => path);
  dirMetas.forEach(file => metaFiles.push(file));

  const metaFile = group.get(tag + '.meta');
  if (metaFile) metaFiles.push(metaFile);

  let nonMetaFiles: Signal<data.File>[] = [];
  const nonMetaFilesGroup =
    group.filter((_, path) => !isDotMeta(path) && Path.parse(path).ext != '.meta')
  nonMetaFilesGroup.forEach(file => nonMetaFiles.push(file));

  return Signal.label(`noteOfGroup(${tag})`, Signal.join(
    Signal.label('join metaFiles', Signal.join(...metaFiles)),
    Signal.label('join nonMetaFiles', Signal.join(...nonMetaFiles))
  ).map(([metaFiles, files]) => {
    let meta: data.Meta = {};
    metaFiles.forEach(metaFile => {
      const metaString = metaFile.buffer.toString('utf8');
      // TODO(jaked) catch JSON parse error
      meta = { ...meta, ...sanitizeMeta(JSON.parse(metaString)) }
    });
    if (!(files.length === 1)) throw new Error(`expected 1 file for ${tag}, ${files}`);
    const file = files[0];
    let type = typeOfPath(file.path);
    if (!meta.type) meta = { ...meta, type };
    if (meta.type !== type) throw new Error(`expected metadata type to match file extension for ${tag}`);
    if (type === 'jpeg') {
      return { ...file, tag, meta, type, content: '' };
    } else {
      const content = file.buffer.toString('utf8');
      return { ...file, tag, meta, type, content };
    }
  }));
}

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
  return Signal.label('notes',
    Signal.mapImmutableMap(groupedFiles, noteOfGroup)
  );
}

function findImportsMdx(ast: MDXHAST.Node, imports: Set<string>) {
  switch (ast.type) {
    case 'root':
    case 'element':
      return ast.children.forEach(child => findImportsMdx(child, imports));

    case 'text':
    case 'jsx':
      break;

    case 'import':
    case 'export':
      if (!ast.declarations) throw new Error('expected import/export node to be parsed');
      ast.declarations.forEach(decls => decls.forEach(decl => {
        switch (decl.type) {
          case 'ImportDeclaration':
            imports.add(decl.source.value);
            break;
        }
      }));
      break;

    default: throw new Error('unexpected AST ' + (ast as MDXHAST.Node).type);
  }
}

function parseMdx(
  trace: Trace,
  tag: string,
  content: string,
  layout: string | undefined,
): { ast: MDXHAST.Root, imports: Set<string> } {
  const ast = Parser.parse(trace, content);
  const imports = new Set<string>();
  // TODO(jaked) fix layout != tag hack
  // layouts shouldn't themselves have layouts
  // but we don't know here that we are defining a layout
  // and a directory-level .meta file can give a layout a layout
  if (layout && layout != tag) imports.add(layout);
  trace.time('findImportsMdx', () => findImportsMdx(ast, imports));
  return { ast, imports };
}

function parseJson(
  content: string
): ESTree.Expression {
  return Parser.parseExpression(content);
}

const emptyImports = new Set<string>();

function parseNote(trace: Trace, note: data.Note): data.ParsedNote {
  switch (note.type) {
    case 'mdx': {
      const type = note.type; // tell TS something it already knows
      try {
        const { ast, imports } = parseMdx(trace, note.tag, note.content, note.meta.layout);
        return { ...note, type, ast: Try.ok(ast), imports };
      } catch (e) {
        return { ...note, type, ast: Try.err(e), imports: emptyImports };
      }
    }

    case 'json': {
      const ast = Try.apply(() => parseJson(note.content));
      const type = note.type; // tell TS something it already knows
      return { ...note, type, ast, imports: emptyImports };
    }

    case 'txt': {
      const type = note.type; // tell TS something it already knows
      return { ...note, type, imports: emptyImports };
    }

    case 'jpeg': {
      const type = note.type; // tell TS something it already knows
      return { ...note, type, imports: emptyImports };
    }

    default:
      throw new Error(`unhandled note type '${(<data.Note>note).type}' for '${(<data.Note>note).tag}'`);
  }
}

function sortNotes(notes: data.ParsedNotes): Array<string> {
  const sortedTags: Array<string> = [];
  const remaining = new Set(notes.keys());
  let again = true;
  while (again) {
    again = false;
    remaining.forEach(tag => {
      const note = notes.get(tag);
      if (!note) throw new Error('expected note');
      const imports = [...note.imports.values()];
      if (debug) console.log('imports for ' + tag + ' are ' + imports.join(' '));
      if (imports.every(tag => sortedTags.includes(tag))) {
        if (debug) console.log('adding ' + tag + ' to order');
        sortedTags.push(tag);
        remaining.delete(tag);
        again = true;
      }
    });
  }
  // any remaining notes can't be parsed, or are part of a dependency loop
  remaining.forEach(tag => {
    if (debug) console.log(tag + ' failed to parse or has a loop');
    sortedTags.push(tag)
  });
  return sortedTags;
}

// dirty notes that import a dirty note (post-sorting for transitivity)
// TODO(jaked)
// don't need to re-typecheck / re-compile a note if it hasn't changed
// and its dependencies haven't changed their types
function dirtyTransitively(
  orderedTags: Array<string>,
  compiledNotes: data.CompiledNotes,
  parsedNotes: data.ParsedNotes
): data.CompiledNotes {
  const dirty = new Set<string>();
  orderedTags.forEach(tag => {
    if (!compiledNotes.has(tag)) {
      if (debug) console.log(tag + ' dirty because file changed');
      dirty.add(tag);
    }
    const note = parsedNotes.get(tag);
    if (!note) throw new Error('expected note');
    const imports = [...note.imports.values()];
    if (debug) console.log('imports for ' + tag + ' are ' + imports.join(' '));
    // a note importing a dirty note must be re-typechecked
    if (!dirty.has(tag) && imports.some(tag => dirty.has(tag))) {
      const dirtyTag = imports.find(tag => dirty.has(tag));
      if (debug) console.log(tag + ' dirty because ' + dirtyTag);
      dirty.add(tag);
    }
  });
  return compiledNotes.filterNot(note => dirty.has(note.tag))
}

function sortProgram(ast: ESTree.Program): ESTree.Program {
  // TODO(jaked)
  // topologically sort bindings as we do for MDX
  return ast;
}

// topologically sort bindings
// TODO(jaked)
// we do this by rearranging the AST
// but that's going to get hairy when we want to provide
// typechecking feedback in the editor
// we need to be careful to retain locations
// or leave the AST alone, but typecheck in toplogical order
function sortMdx(ast: MDXHAST.Root): MDXHAST.Root {
  const imports: Array<ESTree.ImportDeclaration> = [];
  const exportLets: Array<ESTree.ExportNamedDeclaration> = [];
  const exportConsts: Array<ESTree.ExportNamedDeclaration> = [];
  const exportDefault: Array<ESTree.ExportDefaultDeclaration> = [];

  function collectImportsExports(ast: MDXHAST.Node): MDXHAST.Node {
    switch (ast.type) {
      case 'root':
      case 'element': {
        const children: Array<MDXHAST.Node> = [];
        ast.children.forEach(child => {
          switch (child.type) {
            case 'import':
            case 'export':
              if (!child.declarations) throw new Error('expected import/export node to be parsed');
              child.declarations.forEach(decls => decls.forEach(decl => {
                switch (decl.type) {
                  case 'ImportDeclaration':
                    imports.push(decl);
                    break;
                  case 'ExportNamedDeclaration':
                    switch (decl.declaration.kind) {
                      case 'let':
                        exportLets.push(decl);
                        break;
                      case 'const':
                        exportConsts.push(decl);
                        break;
                    }
                    break;
                  case 'ExportDefaultDeclaration':
                    exportDefault.push(decl);
                }
              }));
              break;

            default:
              children.push(collectImportsExports(child));
          }
        });
        return { ...ast, children };
      }

      default:
        return ast;
    }
  }

  const ast2 = collectImportsExports(ast) as MDXHAST.Root;

  let decls: Array<[ ESTree.VariableDeclarator, Array<string> ]> = [];
  exportConsts.forEach(decl => {
    decl.declaration.declarations.forEach(decl => {
      decls.push([ decl, ESTree.freeIdentifiers(decl.init) ])
    })
  })

  const sortedDecls: Array<ESTree.VariableDeclarator> = [];
  let again = true;
  while (again) {
    again = false;
    decls = decls.filter(([ decl, free ]) => {
      if (free.every(id => sortedDecls.some(decl => decl.id.name === id))) {
        sortedDecls.push(decl);
        again = true;
        return false;
      } else {
        return true;
      }
    });
  }
  // remaining decls are part of a dependency loop
  decls.forEach(([ decl, _ ]) => {
    sortedDecls.push(decl);
  });

  // keep the ExportNamedDeclaration nodes so we can highlight keywords
  // but put all the sorted VariableDeclarators in the first one
  const sortedExportConsts = exportConsts.map((decl, i) => {
    if (i === 0) {
      const declaration =
        { ...decl.declaration, declarations: sortedDecls };
      return { ...decl, declaration };
    } else {
      const declaration =
        { ...decl.declaration, declarations: [] };
      return { ...decl, declaration };
    }
  });

  const children: MDXHAST.Node[] = [
    {
      type: 'import',
      value: '',
      declarations: Try.ok(imports),
    },
    {
      // TODO(jaked)
      // a cell should not depend on another definition
      // in its initializer
      type: 'export',
      value: '',
      declarations: Try.ok(exportLets),
    },
    {
      type: 'export',
      value: '',
      declarations: Try.ok(sortedExportConsts),
    },
    {
      type: 'export',
      value: '',
      declarations: Try.ok(exportDefault),
    },
    ...ast2.children
  ];
  return { ...ast2, children };
}

function compileTxt(
  content: string
): data.Compiled {
  const exportType = Type.module({ default: Type.string });
  const exportValue = { default: Signal.ok(content) }
  const rendered = Signal.ok(
    React.createElement('pre', null, content)
  );
  return { exportType, exportValue, rendered };
}

// TODO(jaked)
// is there a way to internalize Typescript types
// so we can generate these? like Scala implicits?
const metaType =
  Type.object({
    type: Type.singleton('mdx'),
    title: Type.undefinedOr(Type.string),
    tags: Type.undefinedOr(Type.array(Type.string)),
    layout: Type.string
  })

function compileMdx(
  trace: Trace,
  ast: MDXHAST.Root,
  capitalizedTag: string,
  meta: data.Meta,
  typeEnv: Typecheck.Env,
  valueEnv: Evaluator.Env,
  moduleTypeEnv: Immutable.Map<string, Type.ModuleType>,
  moduleValueEnv: ModuleValueEnv,
  mkCell: (module: string, name: string, init: any) => Signal.Cell<any>,
): data.Compiled {
  const exportTypes: { [s: string]: Type.Type } = {};
  const exportValue: { [s: string]: Signal<any> } = {};

  ast = trace.time('sortMdx', () => sortMdx(ast));
  trace.time('synthMdx', () => Typecheck.synthMdx(ast, moduleTypeEnv, typeEnv, exportTypes));
  const exportType = Type.module(exportTypes);

  let layoutFunction: undefined | Signal<(props: { children: React.ReactNode, meta: data.Meta }) => React.ReactNode>;
  if (meta.layout) {
    const layoutType =
      Type.functionType(
        [ Type.object({
          children: Type.array(Type.reactNodeType),
          meta: metaType
        }) ],
        Type.reactNodeType);
    const layoutModule = moduleTypeEnv.get(meta.layout);
    if (layoutModule) {
      // TODO(jaked) add a .get method on Type.ModuleType
      const defaultField = layoutModule.fields.find(field => field.field === 'default');
      if (defaultField) {
        if (Type.isSubtype(defaultField.type, layoutType)) {
          const layoutModule = moduleValueEnv.get(meta.layout);
          if (layoutModule) {
            layoutFunction = layoutModule['default'];
          }
        }
      }
    }
  }

  const rendered =
    trace.time('renderMdx', () => {
      const [_, node] =
        Render.renderMdx(ast, capitalizedTag, moduleValueEnv, valueEnv, mkCell, exportValue);
      if (layoutFunction)
        return Signal.join(layoutFunction, node).map(([layoutFunction, node]) =>
          layoutFunction({ children: node, meta })
        );
      else return node;
    });
  return { exportType, exportValue, rendered };
}

function compileJson(
  ast: ESTree.Expression
): data.Compiled {
  const type = Typecheck.synth(ast, Typecheck.env());
  const exportType = Type.module({ default: type });
  const value = Evaluator.evaluateExpression(ast, Immutable.Map());
  const exportValue = { default: Signal.ok(value) }
  const rendered = Signal.ok(
    React.createElement(Inspector, { data: value, expandLevel: 1 })
  );
  return { exportType, exportValue, rendered };
}

function compileJpeg(
  tag: string
): data.Compiled {
  // TODO(jaked) parse JPEG file and return metadata
  const exportType = Type.module({ });
  const exportValue = { }
  const rendered = Signal.ok(
    // it doesn't seem to be straightforward to create an img node
    // directly from JPEG data, so we serve it via the dev server
    // TODO(jaked) plumb port from top-level
    React.createElement(
      'img',
      {
        src: `http://localhost:3000/${tag}`,
        style: {
          maxWidth: '100%',
          objectFit: 'contain' // ???
        }
      }
    )
  );
  return { exportType, exportValue, rendered };
}

function compileNote(
  trace: Trace,
  parsedNote: data.ParsedNote,
  typeEnv: Typecheck.Env,
  valueEnv: Evaluator.Env,
  moduleTypeEnv: Immutable.Map<string, Type.ModuleType>,
  moduleValueEnv: Evaluator.Env,
  mkCell: (module: string, name: string, init: any) => Signal.Cell<any>,
): Try<data.Compiled> {
  return Try.apply(() => {
    switch (parsedNote.type) {
      case 'mdx':
        return compileMdx(
          trace,
          parsedNote.ast.get(),
          String.capitalize(parsedNote.tag),
          parsedNote.meta,
          typeEnv,
          valueEnv,
          moduleTypeEnv,
          moduleValueEnv,
          mkCell,
        );

      case 'json': {
        return compileJson(parsedNote.ast.get());
      }

      case 'txt':
        return compileTxt(parsedNote.content);

      case 'jpeg':
        return compileJpeg(
          parsedNote.tag
        );

      default:
        throw new Error(`unhandled note type '${(<data.ParsedNote>parsedNote).type}'`);
    }
  });
}

function compileDirtyNotes(
  trace: Trace,
  orderedTags: Array<string>,
  parsedNotes: data.ParsedNotes,
  compiledNotes: data.CompiledNotes,
  mkCell: (module: string, name: string, init: any) => Signal.Cell<any>,
  setSelected: (note: string) => void,
): data.CompiledNotes {
  let typeEnv = Render.initTypeEnv;
  let valueEnv = Render.initValueEnv(setSelected);
  let moduleTypeEnv: Immutable.Map<string, Type.ModuleType> = Immutable.Map();
  let moduleValueEnv: Evaluator.Env = Immutable.Map();
  orderedTags.forEach(tag => {
    const compiledNote = compiledNotes.get(tag);
    if (compiledNote) {
      if (debug) console.log('adding type / value env for ' + tag);
      compiledNote.compiled.forEach(compiled => {
        moduleTypeEnv = moduleTypeEnv.set(tag, compiled.exportType);
        moduleValueEnv = moduleValueEnv.set(tag, compiled.exportValue);
      });
    } else {
      const parsedNote = parsedNotes.get(tag);
      if (!parsedNote) throw new Error('expected note');
      if (debug) console.log('typechecking / rendering ' + tag);
      const compiled =
        trace.time(tag, () => compileNote(trace, parsedNote, typeEnv, valueEnv, moduleTypeEnv, moduleValueEnv, mkCell));
      compiled.forEach(compiled => {
        moduleTypeEnv = moduleTypeEnv.set(tag, compiled.exportType);
        moduleValueEnv = moduleValueEnv.set(tag, compiled.exportValue);
      });
      const compiledNote = { ...parsedNote, compiled };
      compiledNotes = compiledNotes.set(tag, compiledNote);
    }
  });
  return compiledNotes;
}

export function compileNotes(
  trace: Trace,
  notesSignal: Signal<data.Notes>,
  mkCell: (module: string, name: string, init: any) => Signal.Cell<any>,
  setSelected: (note: string) => void,
): Signal<data.CompiledNotes> {
  const parsedNotesSignal =
    Signal.label('parseNotes',
      Signal.mapImmutableMap(
        notesSignal,
        note => note.map(note => parseNote(trace, note))
      )
    );

  // TODO(jaked)
  // maybe could do this with more fine-grained Signals
  // but it's easier to do all together
  return Signal.label('compileNotes',
    Signal.mapWithPrev(
      Signal.joinImmutableMap(parsedNotesSignal),
      (parsedNotes, prevParsedNotes, compiledNotes) => {
        const { added, changed, deleted } = diffMap(prevParsedNotes, parsedNotes);

        changed.forEach((v, tag) => { compiledNotes = compiledNotes.delete(tag) });
        deleted.forEach((v, tag) => { compiledNotes = compiledNotes.delete(tag) });

        // topologically sort notes according to imports
        const orderedTags = trace.time('sortNotes', () => sortNotes(parsedNotes));

        // dirty notes that import a dirty note (post-sorting for transitivity)
        compiledNotes = trace.time('dirtyTransitively', () => dirtyTransitively(orderedTags, compiledNotes, parsedNotes));

        // compile dirty notes (post-sorting for dependency ordering)
        compiledNotes = trace.time('compileDirtyNotes', () => compileDirtyNotes(trace, orderedTags, parsedNotes, compiledNotes, mkCell, setSelected));
        return compiledNotes;
      },
      Immutable.Map(),
      Immutable.Map()
    )
  );
}
