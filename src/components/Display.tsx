import * as Immutable from 'immutable';
import * as React from 'react';
import { Atom, ReadOnlyAtom } from '@grammarly/focal';
import * as Focal from '@grammarly/focal';

import * as data from './../data';
import * as Render from '../lang/Render';

interface Props {
  state: Atom<Immutable.Map<string, any>>;
  selected: ReadOnlyAtom<string | null>;
  compiledNotes: ReadOnlyAtom<data.Notes>;
}

// we can't just lift Display because that lifts state as well as content
// then we can't access state as an Atom
// so we lift just the rendering of content
// TODO(jaked) there's probably a simpler way to do this
class Identity extends React.Component<{ tree: React.ReactNode }> {
  render() { return this.props.tree; }
}
const LiftedIdentity = Focal.lift(Identity);

export function Display({ state, selected, compiledNotes }: Props) {
  const tree =
    Atom.combine(selected, compiledNotes, (selected, compiledNotes) => {
      try {
        if (selected) {
          const note = compiledNotes.get(selected);
          if (note && note.compiled && note.compiled) {
            const compiledAst = note.compiled.compiledAst;
            switch (compiledAst.type) {
              case 'success':
                const ast = compiledAst.success;
                const env = Immutable.Map<string, any>();
                return Render.renderMdx(ast, env, state);
              case 'failure':
                throw compiledAst.failure;
            }
          }
        }
        throw 'no note';
      } catch (e) {
        return <span>{e.toString()}</span>
      }
    });

  return <LiftedIdentity tree={tree} />;
}
