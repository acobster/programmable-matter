import * as Immutable from 'immutable';
import Signal from '../../util/Signal';
import Type from '../Type';
import * as data from '../../data';
import File from '../../files/File';

import compileFileTable from './compileFileTable';

const setSelected = (s: string) => {}
const updateFile = (s: string, b: Buffer) => {}
const deleteFile = (s: string) => {}

it('succeeds with syntax error', () => {
  console.log = jest.fn();
  const compiled = compileFileTable(
    new File(
      'foo.table',
      Buffer.from(`#Q(*&#$)`),
    ),
    Signal.ok(Immutable.Map()),
    Signal.ok(Immutable.Map()),
    setSelected,
    updateFile,
    deleteFile,
  );
  compiled.reconcile();
  expect(compiled.get().problems).toBeTruthy();
});

it('succeeds with type error', () => {
  console.log = jest.fn();
  const compiled = compileFileTable(
    new File(
      'foo.table',
      Buffer.from(`{ }`),
    ),
    Signal.ok(Immutable.Map()),
    Signal.ok(Immutable.Map()),
    setSelected,
    updateFile,
    deleteFile,
  );
  compiled.reconcile();
  expect(compiled.get().problems).toBeTruthy();
});

it('empty table', () => {
  const compiled = compileFileTable(
    new File(
      'foo.table',
      Buffer.from(`{
        fields: [
          {
            name: 'foo',
            label: 'Foo',
            kind: 'data',
            type: 'string',
          }
        ]
      }`),
    ),
    Signal.ok(Immutable.Map()),
    Signal.ok(Immutable.Map()),
    setSelected,
    updateFile,
    deleteFile,
  );
  compiled.reconcile();
  compiled.get().rendered.reconcile();
  expect(() => compiled.get().rendered.get()).not.toThrow();
});

it('non-data note in table dir', () => {
  const compiled = compileFileTable(
    new File(
      '/foo/index.table',
      Buffer.from(`{
        fields: [
          {
            name: 'foo',
            label: 'Foo',
            kind: 'data',
            type: 'string',
          }
        ]
      }`),
    ),
    Signal.ok(Immutable.Map()),
    Signal.ok(Immutable.Map({
      '/foo/bar': {
        name: '/foo/bar',
        meta: Signal.ok(data.Meta()),
        files: {},
        problems: Signal.ok(false),
        rendered: Signal.ok(null),
        publishedType: Signal.ok('html' as const),
        exportType: Signal.ok(Type.module({})),
        exportValue: Signal.ok({}),
      }
    })),
    setSelected,
    updateFile,
    deleteFile,
  );
  compiled.reconcile();
  compiled.get().rendered.reconcile();
  expect(() => compiled.get().rendered.get()).not.toThrow();
});
