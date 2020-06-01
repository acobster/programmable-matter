import * as Immutable from 'immutable';
import Signal from '../../util/Signal';
import Trace from '../../util/Trace';
import * as data from '../../data';

import compileFileTable from './compileFileTable';

const trace = new Trace();
const setSelected = (s: string) => {}
const updateFile = (s: string, b: Buffer) => {}
const deleteFile = (s: string) => {}

it('succeeds with syntax error', () => {
  console.log = jest.fn();
  const compiled = compileFileTable(
    trace,
    new data.File(
      'foo.table',
      Signal.cellOk(Buffer.from(`#Q(*&#$)`)),
    ),
    Signal.ok(Immutable.Map()),
    Signal.ok(Immutable.Map()),
    setSelected,
    updateFile,
    deleteFile,
  );
  compiled.reconcile(trace, 1);
  expect(compiled.get().problems).toBeTruthy();
});

it('succeeds with type error', () => {
  console.log = jest.fn();
  const compiled = compileFileTable(
    trace,
    new data.File(
      'foo.table',
      Signal.cellOk(Buffer.from(`{ }`)),
    ),
    Signal.ok(Immutable.Map()),
    Signal.ok(Immutable.Map()),
    setSelected,
    updateFile,
    deleteFile,
  );
  compiled.reconcile(trace, 1);
  expect(compiled.get().problems).toBeTruthy();
});

it('empty table', () => {
  const compiled = compileFileTable(
    trace,
    new data.File(
      'foo.table',
      Signal.cellOk(Buffer.from(`{
        fields: [
          {
            name: 'foo',
            label: 'Foo',
            kind: 'data',
            type: 'string',
          }
        ]
      }`)),
    ),
    Signal.ok(Immutable.Map()),
    Signal.ok(Immutable.Map()),
    setSelected,
    updateFile,
    deleteFile,
  );
  compiled.reconcile(trace, 1);
  compiled.get().rendered.reconcile(trace, 1);
  expect(() => compiled.get().rendered.get()).not.toThrow();
});
