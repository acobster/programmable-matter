import * as Immer from 'immer';
import { Editor, Element, Node, Path, Point, Range, Transforms } from 'slate';
import * as PMAST from '../model/PMAST';
import { bug } from '../util/bug';

function hasPrevious(path: Path) {
  return path[path.length - 1] > 0;
}

export const normalizeNode = (editor: Editor) => {
  const { normalizeNode } = editor;
  return ([node, path]: [Node, Path]) => {

    // remove empty inlines
    if ((PMAST.isLink(node) || PMAST.isInlineCode(node)) && Editor.isEmpty(editor, node)) {
      if (editor.selection) {
        // if a selection endpoint is in the link,
        // unwrapping the link and normalizing can move the endpoint to the previous node
        // to avoid this move the endpoint after the link
        // TODO(jaked) better way to do this?
        const inPoint = { path: path.concat(0), offset: 0 };
        const afterPoint = Editor.after(editor, inPoint) ?? bug('expected after');
        // TODO(jaked) should maybe use Transforms.select here
        editor.selection = Immer.produce(editor.selection, selection => {
          for (const [point, endpoint] of Range.points(selection)) {
            if (Point.equals(point, inPoint))
              selection[endpoint] = afterPoint;
          }
        });
      }
      Transforms.unwrapNodes(editor, { at: path });
      return;
    }

    // merge adjacent lists / block quotes
    if ((PMAST.isList(node) || PMAST.isBlockquote(node)) && hasPrevious(path)) {
      const prevPath = Path.previous(path);
      const prevNode = Node.get(editor, prevPath);
      if (prevNode.type === node.type) {
        return Transforms.mergeNodes(editor, { at: path });
      }
    }

    // work around an apparent Slate bug:
    // Transforms.mergeNodes moves a node's children into the previous node
    // but the children are not marked dirty so are not normalized
    // if their normalization depends on siblings (as here)
    // then the tree is left in an unnormalized state
    if (Element.isElement(node)) {
      for (const [child, childPath] of Node.children(editor, path)) {
        if ((PMAST.isList(child) || PMAST.isBlockquote(child)) && hasPrevious(childPath)) {
          const prevPath = Path.previous(childPath);
          const prevNode = Node.get(editor, prevPath);
          if (prevNode.type === child.type) {
            return Transforms.mergeNodes(editor, { at: childPath });
          }
        }
      }
    }

    // Transforms.moveNodes can leave empty nodes
    // default normalizeNode inserts a { text: "" }
    if ((PMAST.isList(node) || PMAST.isListItem(node)) && node.children.length === 0) {
      return Transforms.removeNodes(editor, { at: path });
    }

    // ensure that list items begin with a p
    // by finding the next p and moving it up
    if (PMAST.isListItem(node) && !PMAST.isParagraph(node.children[0])) {
      if (hasPrevious(path)) {
        return Transforms.mergeNodes(editor, { at: path });
      } else {
        // TODO(jaked) check that the p is in an li and not a blockquote etc.
        const [p] = Editor.nodes(editor, { at: path, match: node => PMAST.isParagraph(node) });
        if (p) {
          const [pNode, pPath] = p;
          Transforms.moveNodes(editor, { at: pPath, to: path.concat(0) });
          return;
        } else {
          return Transforms.insertNodes(
            editor,
            { type: 'p', children: [] },
            { at: path.concat(0) }
          );
        }
      }
    }

    normalizeNode([node, path]);
  }
}
