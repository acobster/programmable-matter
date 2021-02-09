/** @jsx jsx */
import { Editor } from 'slate';
import { jsx } from '../util/slate-hyperscript-jsx';
import { expectEditor } from './expectEditor';
import { deleteBackward } from './deleteBackward';

it(`dedents when cursor is at start of header and block is not empty`, () => {
  expectEditor(
    <editor>
      <h1><cursor/>foo</h1>
    </editor>,

    editor => {
      deleteBackward(editor)('character')
    },

    <editor>
      <p><cursor/>foo</p>
    </editor>
  );
});

it(`dedents when cursor is at start of list item and block is not empty`, () => {
  expectEditor(
    <editor>
      <ul><li><p><cursor/>foo</p></li></ul>
    </editor>,

    editor => {
      deleteBackward(editor)('character')
    },

    <editor>
      <p><cursor/>foo</p>
    </editor>
  );
});

it(`deletes backward when block is maximally dedented`, () => {
  expectEditor(
    <editor>
      <p>foo</p>
      <p><cursor/>bar</p>
    </editor>,

    editor => {
      deleteBackward(editor)('character')
    },

    <editor>
      <p>foo<cursor/>bar</p>
    </editor>
  );
});

it(`deletes list item with nested list`, () => {
  // normalizeNode makes this work
  expectEditor(
    <editor>
      <ul>
        <li><p>foo</p></li>
        <li>
          <p><cursor/></p>
          <ul>
            <li><p>baz</p></li>
          </ul>
        </li>
      </ul>
    </editor>,

    editor => {
      deleteBackward(editor)('character');
    },

    <editor>
      <ul>
        <li>
          <p>foo<cursor/></p>
          <ul>
            <li><p>baz</p></li>
          </ul>
        </li>
      </ul>
    </editor>
  )
});
