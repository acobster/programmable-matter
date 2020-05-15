import * as Path from 'path';
import * as Immutable from 'immutable';
import Signal from '../../util/Signal';
import Try from '../../util/Try';
import * as Tag from '../../util/Tag';
import Type from '../Type';
import * as data from '../../data';

function extractMeta(meta: Signal<data.CompiledFile>): Signal<data.Meta> {
  return meta.flatMap(meta =>
    meta.exportValue.default.liftToTry().map(metaTry => {
      switch (metaTry.type) {
        case 'ok':
          return metaTry.ok;
        case 'err':
          return {};
      }
    })
  );
}

const emptyMeta: Signal<data.CompiledFile> = Signal.ok({
  exportType: Type.module({ }),
  exportValue: { default: Signal.ok(data.Meta({})) },
  rendered: Signal.ok(null),
  problems: false,
  ast: Try.ok(null),
})

export default function metaForPath(
  path: string,
  compiledFiles: Signal<Immutable.Map<string, Signal<data.CompiledFile>>>,
): Signal<data.Meta> {
  const pathParsed = Path.parse(path);
  const indexMetaPath = Path.format({ ...pathParsed, base: 'index.meta' });
  const metaPath = Path.format({ ...pathParsed, base: pathParsed.name + '.meta' });

  return compiledFiles.flatMap(compiledFiles => {
    const indexMeta = extractMeta(compiledFiles.get(indexMetaPath) ?? emptyMeta);
    const meta = extractMeta(compiledFiles.get(metaPath) ?? emptyMeta);
    return Signal.join(indexMeta, meta)
      .map(([indexMeta, meta]) => data.Meta({
        title: meta.title ?? indexMeta.dirMeta?.title ?? Path.parse(Tag.tagOfPath(path)).base,
        tags: meta.tags ?? indexMeta.dirMeta?.tags,
        layout: meta.layout ?? indexMeta.dirMeta?.layout,
        publish: meta.publish ?? indexMeta.dirMeta?.publish,
        dataType: meta.dataType ?? indexMeta.dirMeta?.dataType,
      }));
  });
}
