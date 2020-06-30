import * as fs from "fs";
import * as Path from 'path';
import { remote } from 'electron';
import util from 'util';
import rimrafCallback from 'rimraf';
import GHPages from 'gh-pages';
const rimraf = util.promisify(rimrafCallback);
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);
const ghPagesPublish = util.promisify(GHPages.publish);

import * as React from 'react';
import ReactDOMServer from 'react-dom/server';

import Trace from '../util/Trace';
import * as Render from '../lang/Render';
import * as data from '../data';

export default async function ghPages(
  compiledNotes: data.CompiledNotes,
  trace: Trace,
  level: number,
) {
  // TODO(jaked) use context provider to avoid manual reconciliation

  // TODO(jaked) generate random dir name?
  const tempdir = Path.resolve(remote.app.getPath("temp"), 'programmable-matter');
  // fs.rmdir(tempdir, { recursive: true }); // TODO(jaked) Node 12.10.0
  await rimraf(tempdir, { glob: false })
  await mkdir(tempdir);
  await writeFile(Path.resolve(tempdir, '.nojekyll'), '');
  await writeFile(Path.resolve(tempdir, 'CNAME'), "jaked.org");
  await Promise.all(compiledNotes.map(async note => {
    // TODO(jaked) don't blow up on failed notes

    note.meta.reconcile(trace, level);
    if (!note.meta.get().publish) return
    note.publishedType.reconcile(trace, level);
    const publishedType = note.publishedType.get();

    if (publishedType === 'jpeg') {
      const base = note.isIndex ? Path.join(note.tag, 'index') : note.tag;
      const path = Path.resolve(tempdir, base) + '.jpeg';

      await mkdir(Path.dirname(path), { recursive: true });
      note.exportValue.reconcile(trace, level);
      const exportValue = note.exportValue.get();
      exportValue.buffer.reconcile(trace, level);
      const buffer = exportValue.buffer.get();
      await writeFile(path, buffer);

    } else if (publishedType === 'html') {
      const base = note.isIndex ? Path.join(note.tag, 'index') : note.tag;
      const path = Path.resolve(tempdir, base) + '.html';

      note.rendered.reconcile(trace, level);
      const rendered = note.rendered.get();
      if (!rendered) return;

      const renderedWithContext =
        React.createElement(Render.context.Provider, { value: 'server' }, rendered)
      const html = ReactDOMServer.renderToStaticMarkup(renderedWithContext);
      await mkdir(Path.dirname(path), { recursive: true });
      await writeFile(path, html);
    }
  }).values());
  await ghPagesPublish(tempdir, {
    src: '**',
    dotfiles: true,
    branch: 'master',
    repo: 'https://github.com/jaked/jaked.github.io.git',
    message: 'published from Programmable Matter',
    name: 'Jake Donham',
    email: 'jake.donham@gmail.com',
  });
}
