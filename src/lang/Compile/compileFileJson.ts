import * as Immutable from 'immutable';
import JSON5 from 'json5';
import * as React from 'react';
import styled from 'styled-components';
import Signal from '../../util/Signal';
import Try from '../../util/Try';
import { bug } from '../../util/bug';
import * as Parse from '../Parse';
import * as ESTree from '../ESTree';
import Type from '../Type';
import Typecheck from '../Typecheck';
import * as Evaluate from '../Evaluate';
import { Interface, Content, CompiledFile } from '../../model';
import { Record } from '../../components/Record';
import lensType from './lensType';
import lensValue from './lensValue';

import metaForPath from './metaForPath';

const Input = styled.input({
  boxSizing: 'border-box',
  borderStyle: 'none',
  outline: 'none',
  fontSize: '14px',
  width: '100%',
  height: '100%',
});

const stringInputComponent = ({ lens }) =>
  React.createElement(Input, {
    type: 'text',
    value: lens(),
    onChange: (e: React.FormEvent<HTMLInputElement>) => lens(e.currentTarget.value)
  });

const booleanInputComponent = ({ lens }) =>
  React.createElement(Input, {
    type: 'checkbox',
    checked: lens(),
    onChange: (e: React.FormEvent<HTMLInputElement>) => lens(e.currentTarget.checked)
  });

const numberInputComponent = ({ lens }) =>
  React.createElement(Input, {
    type: 'text',
    value: String(lens()),
    onChange: (e: React.FormEvent<HTMLInputElement>) => lens(Number(e.currentTarget.value))
  });

function fieldComponent(field: string, type: Type) {
  switch (type.kind) {
    case 'string': return stringInputComponent;
    case 'boolean': return booleanInputComponent;
    case 'number': return numberInputComponent;

    case 'Union':
      // TODO(jaked) support non-required select if `undefined` in union
      if (type.types.some(type => type.kind !== 'Singleton' || type.base.kind !== 'string'))
        bug(`unhandled type ${Type.toString(type)} in fieldComponent`);
      return ({ lens }) =>
        React.createElement(
          'select',
          {
            required: true,
            value: lens(),
            onChange: (e: React.FormEvent<HTMLInputElement>) => lens(e.currentTarget.value)
          },
          ...type.types.map(type => {
            if (type.kind !== 'Singleton' || type.base.kind !== 'string')
              bug(`unhandled type ${Type.toString(type)} in fieldComponent`);
            return React.createElement('option', { value: type.value }, type.value);
          })
        );

    default:
      bug(`unhandled type ${Type.toString(type)} in fieldComponent`);
  }
}

export default function compileFileJson(
  file: Content,
  compiledFiles: Signal<Map<string, CompiledFile>> = Signal.ok(new Map()),
  updateFile: (path: string, buffer: Buffer) => void = (path: string, buffer: Buffer) => { },
): CompiledFile {
  const ast = file.content.map(content => Parse.parseExpression(content as string));

  // TODO(jaked) support typechecking from index.table file

  const meta = metaForPath(file.path, compiledFiles);

  const compiled = Signal.join(ast, meta).map(([ast, meta]) => {
    const interfaceMap = new Map<ESTree.Node, Interface>();
    const intf =
      meta.dataType ?
        Typecheck.check(ast, Typecheck.env(), meta.dataType, interfaceMap) :
        Typecheck.synth(ast, Typecheck.env(), interfaceMap);
    const problems = [...interfaceMap.values()].some(intf => intf.type === 'err');

    if (intf.type === 'err') {
      // TODO(jaked) these should be Signal.err
      const exportInterface = new Map([
        [ 'default', intf ],
        [ 'mutable', intf ],
      ]);
      const exportValue = new Map([
        [ 'default', intf.err ],
        [ 'mutable', intf.err ]
      ]);
      const rendered = Signal.ok(null);
      return {
        exportInterface,
        exportValue,
        rendered,
        interfaceMap,
        problems,
      }
    } else {
      const type = meta.dataType ? meta.dataType : intf.ok.type;

      // TODO(jaked) handle other JSON types
      if (type.kind !== 'Object') bug(`expected Object type`);
      const typeObject = type;

      const exportInterface = new Map([
        [ 'default', Try.ok({ type, dynamic: false }) ],
        [ 'mutable', Try.ok({ type: lensType(type), dynamic: false }) ],
      ]);
      const value = Evaluate.evaluateExpression(ast, interfaceMap, Immutable.Map());
      const setValue = (v) => updateFile(file.path, Buffer.from(JSON5.stringify(v, undefined, 2), 'utf-8'));
      const lens = lensValue(value, setValue, type);
      const exportValue = new Map([
        [ 'default', value ],
        [ 'mutable', lens ]
      ]);

      const rendered = Signal.constant(Try.apply(() => {
        // TODO(jaked) error handling here
        const fields = typeObject.fields.map(({ _1: name, _2: type }) => ({
          label: name,
          accessor: (o: object) => o[name],
          component: fieldComponent(name, type)
        }));

        // TODO(json) handle arrays of records (with Table)
        return React.createElement(Record, { object: lens, fields: fields.toArray() });
      }));

      return {
        exportInterface,
        exportValue,
        rendered,
        interfaceMap,
        problems: false,
      };
    }
  });

  return {
    ast,
    exportInterface: compiled.map(({ exportInterface }) => exportInterface),
    interfaceMap: compiled.map(({ interfaceMap }) => interfaceMap),
    problems: compiled.liftToTry().map(compiled =>
      compiled.type === 'ok' ? compiled.ok.problems : true
    ),
    exportValue: compiled.map(({ exportValue }) => exportValue),
    rendered: compiled.flatMap(({ rendered }) => rendered),
  };
}
