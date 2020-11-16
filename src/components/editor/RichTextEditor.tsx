import React from 'react';
import { createEditor, Editor, Node, Path, Point } from 'slate';
import { withReact, Editable, RenderElementProps, RenderLeafProps, Slate } from 'slate-react';
import isHotkey from 'is-hotkey';
import styled from 'styled-components';

import Try from '../../util/Try';
import * as data from '../../data';
import * as PMAST from '../../PMAST';
import * as ESTree from '../../lang/ESTree';
import * as PMEditor from '../../editor/PMEditor';
import * as Highlight from '../../lang/highlight';

const okComponents =
{
  default:    styled.span({ color: '#000000' }),
  atom:       styled.span({ color: '#221199' }),
  number:     styled.span({ color: '#116644' }),
  string:     styled.span({ color: '#aa1111' }),
  keyword:    styled.span({ color: '#770088' }),
  definition: styled.span({ color: '#0000ff' }),
  variable:   styled.span({ color: '#268bd2' }),
  property:   styled.span({ color: '#b58900' }),
  // TODO(jaked)
  // hover doesn't work because enclosing pre is not on top
  link:       styled.span`
    :hover {
      cursor: pointer;
    }
    color: #aa1111;
    text-decoration: underline;
  `,
}

const errStyle = { backgroundColor: '#ffc0c0' };

const errComponents =
{
  default:    styled(okComponents.default)(errStyle),
  atom:       styled(okComponents.atom)(errStyle),
  number:     styled(okComponents.number)(errStyle),
  string:     styled(okComponents.string)(errStyle),
  keyword:    styled(okComponents.keyword)(errStyle),
  definition: styled(okComponents.definition)(errStyle),
  variable:   styled(okComponents.variable)(errStyle),
  property:   styled(okComponents.property)(errStyle),
  link:       styled(okComponents.link)(errStyle),
}

export const renderElement = ({ element, attributes, children }: RenderElementProps) => {
  const pmElement = element as PMAST.Element;
  if (pmElement.type === 'a') {
    return React.createElement('a', { ...attributes, href: pmElement.href }, children);
  } else if (pmElement.type === 'code') {
    return React.createElement('pre', attributes,
      React.createElement('code', {}, children)
    );
  } else if (pmElement.type === 'inlineCode') {
    return React.createElement('code', {}, children);
  } else {
    return React.createElement(pmElement.type, attributes, children);
  }
}

export const renderLeaf = ({ leaf, attributes, children } : RenderLeafProps) => {
  const text = leaf as PMAST.Text;
  if (text.highlight) {
    const component = text.status ? errComponents[text.highlight] : okComponents[text.highlight];
    return React.createElement(
      component as any,
      {...attributes, 'data-status': text.status, 'data-link': text.link },
      children
    );

  } else {
    if (text.bold)
      children = <strong>{children}</strong>;
    if (text.italic)
      children = <em>{children}</em>;
    if (text.underline)
      children = <u>{children}</u>;
    if (text.code)
      children = <code>{children}</code>;

    return <span {...attributes}>{children}</span>;
  }
}

type Range = {
  anchor: Point;
  focus: Point;
  highlight: Highlight.tag;
  status?: string;
  link?: string;
}

export const makeDecorate =
  ({ parsedCode }: { parsedCode: WeakMap<Node, unknown> }) =>
  ([node, path]: [Node, Path]) => {
    // TODO(jaked) cache decorations
    const ranges: Range[] = [];
    const code = parsedCode.get(node) as Try<ESTree.Node>;
    if (code && code.type === 'ok') {
      const spans: Highlight.Span[] = [];
      Highlight.computeJsSpans(code.ok, undefined, spans);
      for (const span of spans) {
        ranges.push({
          anchor: { path, offset: span.start },
          focus: { path, offset: span.end },
          highlight: span.tag,
          status: span.status,
          link: span.link
        });
      }
    }
    return ranges;
  }

const MARK_HOTKEYS = {
  'mod+b': 'bold',
  'mod+i': 'italic',
  'mod+u': 'underline',
  'mod+`': 'code',
}

const TYPE_HOTKEYS ={
  'mod+opt+0': 'p',
  'mod+opt+1': 'h1',
  'mod+opt+2': 'h2',
  'mod+opt+3': 'h3',
  'mod+opt+4': 'h4',
  'mod+opt+5': 'h5',
  'mod+opt+6': 'h6',
  'mod+opt+7': 'ul',
  'mod+opt+8': 'ol',
}

export const makeOnKeyDown = (editor: Editor) =>
  (re: React.KeyboardEvent) => {
    const e = re as unknown as KeyboardEvent;
    if (isHotkey('tab', e)) {
      e.preventDefault();
      PMEditor.indent(editor);
    }
    if (isHotkey('shift+tab', e)) {
      e.preventDefault();
      PMEditor.dedent(editor);
    }
    if (isHotkey('shift+enter', e)) {
      e.preventDefault();
      PMEditor.softBreak(editor);
    }
    if (isHotkey('mod+enter', e)) {
      e.preventDefault();
      PMEditor.exitBreak(editor);
    }
    for (const hotkey in MARK_HOTKEYS) {
      if (isHotkey(hotkey, e)) {
        e.preventDefault();
        const mark = MARK_HOTKEYS[hotkey];
        PMEditor.toggleMark(editor, mark);
      }
    }
    for (const hotkey in TYPE_HOTKEYS) {
      if (isHotkey(hotkey, e)) {
        e.preventDefault();
        const type = TYPE_HOTKEYS[hotkey];
        PMEditor.setType(editor, type);
      }
    }
  }

export type RichTextEditorProps = {
  value: PMAST.Node[];
  setValue: (nodes: PMAST.Node[]) => void;
  compiledFile: data.CompiledFile;
}

const RichTextEditor = (props: RichTextEditorProps) => {
  const editor = React.useMemo(() => withReact(PMEditor.withPMEditor(createEditor())), []);
  const onKeyDown = React.useMemo(() => makeOnKeyDown(editor), [editor]);
  const decorate = React.useMemo(
    () => makeDecorate(props.compiledFile.ast.get()), // TODO(jaked) fix get
    [props.compiledFile]
  );
  return (
    <Slate
      editor={editor}
      value={props.value}
      onChange={props.setValue as (nodes: Node[]) => void}
    >
      <Editable
        renderElement={renderElement}
        renderLeaf={renderLeaf}
        decorate={decorate}
        onKeyDown={onKeyDown}
      />
    </Slate>
  );
}

export default RichTextEditor;
