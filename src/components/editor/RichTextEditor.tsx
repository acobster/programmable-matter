import React from 'react';

import * as Slate from 'slate';
import * as SlateReact from 'slate-react';

import isHotkey from 'is-hotkey';

import * as PMAST from '../../PMAST';

import * as PMEditor from './PMEditor';

import { bug } from '../../util/bug';

const renderElement = ({ element, attributes, children }: SlateReact.RenderElementProps) => {
  switch (element.type) {
    case 'p':
      return <p {...attributes}>{children}</p>
    default:
      bug(`unexpected element type '${element.type}'`);
  }
}

const renderLeaf = ({ leaf, attributes, children } : SlateReact.RenderLeafProps) => {
  if (leaf.bold) {
    children = <strong>{children}</strong>
  }

  return <span {...attributes}>{children}</span>
}

export const makeOnKeyDown = (editor: PMEditor.PMEditor) =>
  (e: React.KeyboardEvent) => {
    if (isHotkey('mod+b', e as unknown as KeyboardEvent)) {
      e.preventDefault();
      editor.toggleBold();
    }
  }

export type RichTextEditorProps = {
  value: PMAST.Node[],
  setValue: (nodes: PMAST.Node[]) => void,
}

const RichTextEditor = (props: RichTextEditorProps) => {
  const editor = React.useMemo(() => SlateReact.withReact(PMEditor.withPMEditor(Slate.createEditor())), []);
  const onKeyDown = React.useMemo(() => makeOnKeyDown(editor), [editor]);
  return (
    <SlateReact.Slate
      editor={editor}
      value={props.value}
      onChange={props.setValue as (nodes: Slate.Node[]) => void}
    >
      <SlateReact.Editable
        renderElement={renderElement}
        renderLeaf={renderLeaf}
        onKeyDown={onKeyDown}
      />
    </SlateReact.Slate>
  );
}

export default RichTextEditor;
