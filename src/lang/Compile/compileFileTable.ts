import * as Immutable from 'immutable';
import * as Immer from 'immer';
import JSON5 from 'json5';
import * as React from 'react';
import Try from '../../util/Try';
import { Tuple2 } from '../../util/Tuple';
import Signal from '../../util/Signal';
import * as Name from '../../util/Name';
import { diffMap as diffImmutableMap } from '../../util/immutable/Map';
import { diffMap } from '../../util/diffMap';
import { bug } from '../../util/bug';
import * as ESTree from '../ESTree';
import * as Parse from '../Parse';
import Type from '../Type';
import Typecheck from '../Typecheck';
import * as Evaluate from '../Evaluate';
import { Interface, InterfaceMap, Content, CompiledFile, CompiledNote, CompiledNotes } from '../../model';
import * as model from '../../model';
import { Table } from '../../components/Table';
import lensType from './lensType';

const intfType = (intf: Interface) =>
  intf.type === 'ok' ? intf.ok.type : Type.error(intf.err);

// see Typescript-level types in data.ts
// TODO(jaked)
// this way of writing the type produces obscure error messages, e.g.
//   expected { name: string, label: string } & { kind: 'data', type: string } | { name: string, label: string } & { kind: 'meta', field: 'name' | 'title' | 'created' | 'upated' }, got {  }
// need to improve checking inside unions / intersections

const tableFieldBaseType = Type.object({
  name: Type.string,
  label: Type.string,
});

const tableFieldDataType = Type.intersection(tableFieldBaseType, Type.object({
  kind: Type.singleton('data'),

  // TODO(jaked)
  // could represent types in JSON
  // or extend JSON syntax / value representation to include types
  type: Type.string,
}));

const tableFieldMetaType = Type.intersection(tableFieldBaseType, Type.object({
  kind: Type.singleton('meta'),
  field: Type.enumerate('name', 'title', 'created', 'updated')
}));

const tableFieldType = Type.union(tableFieldDataType, tableFieldMetaType);

const tableType =
  Type.object({
    fields: Type.array(tableFieldType)
  });

function computeTableConfig(
  ast: ESTree.Expression,
  interfaceMap: InterfaceMap,
): model.Table {
  // TODO(jaked)
  // blows up if a type string cannot be parsed
  // but we don't annotate the expression to indicate the problem
  // tricky since we have discarded the AST already
  // maybe we could evaluate with respect to a type
  // and do conversion internally to evaluation
  return {
    fields: (Evaluate.evaluateExpression(ast, interfaceMap, Immutable.Map()) as any).fields.map(field => {
      switch (field.kind) {
        case 'data':
          const type = Parse.parseType(field.type);
          field = { ...field, type }
      }
      return field;
    })
  };
}

function computeTableDataType(
  tableConfig: model.Table
): Type.ObjectType {
  const tableDataFields: { name: string, type: Type }[] = [];
  tableConfig.fields.forEach(field => {
    if (field.kind === 'data') {
      tableDataFields.push({ name: field.name, type: field.type });
    }
  });
  return Type.object(tableDataFields);
}

function computeTable(
  tableConfig: model.Table,
  tableDataType: Type.ObjectType,
  tableName: string,
  noteEnv: Map<string, CompiledNote>,
  updateFile: (path: string, buffer: Buffer) => void,
  deleteFile: (path: string) => void,
) {
  const tryLensTable = Signal.joinImmutableMap(Signal.ok(
    Immutable.Map<string, Signal<Try<any>>>().withMutations(map =>
      noteEnv.forEach((note, name) => {
        const mutableValue = note.exportValue.map(exportValue =>
          exportValue.get('mutable') ?? bug(`expected mutable value`)
        );

        const metaValue = note.meta.map(meta =>
          tableConfig.fields.reduce<object>(
            (obj, field) => {
              if (field.kind === 'meta') {
                switch (field.field) {
                  case 'title': return { obj, [field.name]: meta.title }
                }
              }
              return obj;
            },
            {}
          ),
        );

        const value = note.exportInterface.flatMap(exportInterface => {
          const defaultIntf = exportInterface.get('default');
          // TODO(jaked)
          // check data files directly against table config
          // instead of checking after the fact
          // that their types agree with the table config type
          const mutableIntf = exportInterface.get('mutable');
          if (!defaultIntf || !mutableIntf || !Type.isSubtype(intfType(defaultIntf), tableDataType))
            // TODO(jaked) check `mutableType` too
            throw new Error('record data type must match table config type')

          return Signal.join(mutableValue, metaValue).map(([mutableValue, metaValue]) => {
            // TODO(jaked) merge mutable data members and immutable meta members
            // TODO(jaked) could some meta members be mutable?
            return mutableValue;
          });
        });

        const baseName = Name.relative(Name.dirname(tableName), name);
        map.set(baseName, value.liftToTry());
      })
    )
  ));
  // TODO(jaked) give return a better type
  return tryLensTable.map<any>(tryLensTable => {
    // skip over failed notes
    // TODO(jaked) reflect failures in UI
    const lensTable = tryLensTable.filter(t => t.type === 'ok').map(t => t.get());

    const table = lensTable.map(v => v());

    const f = function(...v: any[]) {
      switch (v.length) {
        case 0: return table;

        case 1: {
          const table2 = v[0];
          const { added, changed, deleted } = diffImmutableMap(table, table2);
          added.forEach((value, key) => {
            const path = Name.pathOfName(Name.join(Name.dirname(tableName), key), 'json');
            updateFile(path, Buffer.from(JSON5.stringify(value, undefined, 2)));
          });
          changed.forEach(([prev, curr], key) => {
            const lens = lensTable.get(key) ?? bug(`expected lens for ${key}`);
            lens(curr);
          });
          deleted.forEach(key => {
            // TODO(jaked) delete multi-part notes
            const path = Name.pathOfName(Name.join(Name.dirname(tableName), key), 'json');
            deleteFile(path);
          });
          return;
        }

        default: bug(`expected 0- or 1-arg invocation`);
      }
    }

    return new Proxy(f, { get: (target, key, receiver) => {
      switch (key) {
        case 'size': return lensTable.size;
        case 'set': return (key, value) => lensTable.set(key, value);
        case 'delete': return (key) => lensTable.delete(key);
        case 'clear': return () => lensTable.clear();
        case 'filter': return (fn) => lensTable.filter(fn);
        case 'toList': return () => lensTable.toList();
        case 'update': return (key, fn) => lensTable.update(key, fn);
        case 'get': return (key, nsv) => lensTable.get(key, nsv);

        default: return undefined;
      }
    }});
  });
}

function computeFields(
  tableConfig: model.Table,
) {
  return tableConfig.fields.map(field => {
    return {
      label: field.label,
      accessor: (o: object) => o[field.name],
      width: 100,
      component: ({ data }) => React.createElement(React.Fragment, null, String(data))
    };
  });
}

export default function compileFileTable(
  file: Content,
  compiledFiles: Signal<Map<string, CompiledFile>> = Signal.ok(new Map()),
  compiledNotes: Signal<CompiledNotes> = Signal.ok(new Map()),
  setSelected: (name: string) => void = (name: string) => { },
  updateFile: (path: string, buffer: Buffer) => void = (path: string, buffer: Buffer) => { },
  deleteFile: (path: string) => void = (path: string) => { },
): CompiledFile {

  const tableName = Name.nameOfPath(file.path);

  const ast = file.content.map(content => Parse.parseExpression(content as string));

  // TODO(jaked) support non-index foo.table
  // TODO(jaked) Signal.filter
  const noteEnv = Signal.mapWithPrev<CompiledNotes, CompiledNotes>(
    compiledNotes,
    (compiledNotes, prevCompiledNotes, prevNoteEnv) => {
      return Immer.produce(prevNoteEnv, (noteEnv: CompiledNotes) => {
        const dir = Name.dirname(tableName);
        const { added, changed, deleted } = diffMap(prevCompiledNotes, compiledNotes);
        added.forEach((compiledNote, name) => {
          if (Name.dirname(name) === dir && name !== tableName)
            noteEnv.set(name, compiledNote);
        });
        changed.forEach(([prev, curr], name) => noteEnv.set(name, curr));
        deleted.forEach(name => noteEnv.delete(name));
      });
    },
    new Map(),
    new Map()
  );

  const compiled = Signal.join(ast, noteEnv).map(([ast, noteEnv]) => {
    const interfaceMap = new Map<ESTree.Node, Interface>();
    const intf = Typecheck.check(ast, Typecheck.env(), tableType, interfaceMap);
    const problems = [...interfaceMap.values()].some(intf => intf.type === 'err');

    if (intf.type === 'err') {
      return {
        // TODO(jaked) these should be Signal.err
        exportInterface: new Map([[ 'default', intf ]]),
        exportValue: Signal.ok(new Map([[ 'default', intf.err ]])),
        rendered: Signal.ok(null),
        interfaceMap,
        problems,
      }
    }
    const tableConfig = computeTableConfig(ast, interfaceMap);
    const tableDataType = computeTableDataType(tableConfig);

    const table = computeTable(tableConfig, tableDataType, tableName, noteEnv, updateFile, deleteFile);

    const fields = computeFields(tableConfig);

    const exportInterface = new Map([
      ['default', Try.ok({ type: lensType(Type.map(Type.string, tableDataType)), dynamic: false })]
    ]);
    const exportValue = table.map(table => new Map([[ 'default', table ]]));

    const onSelect = (name: string) => setSelected(Name.join(Name.dirname(tableName), name));

    const rendered = table.map(table =>
      React.createElement(Table, { data: table(), fields, onSelect })
    );
    return {
      exportInterface,
      exportValue,
      rendered,
      interfaceMap,
      problems,
    };
  });

  return {
    ast,
    exportInterface: compiled.map(({ exportInterface }) => exportInterface),
    interfaceMap: compiled.map(({ interfaceMap }) => interfaceMap),
    problems: compiled.liftToTry().map(compiled =>
      compiled.type === 'ok' ? compiled.ok.problems : true
    ),
    exportValue: compiled.flatMap(({ exportValue }) => exportValue),
    rendered: compiled.flatMap(({ rendered }) => rendered),
  };
}
