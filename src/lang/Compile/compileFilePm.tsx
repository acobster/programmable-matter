import Path from 'path';
import * as Immutable from 'immutable';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

import { bug } from '../../util/bug';
import * as model from '../../model';
import * as Name from '../../util/Name';
import Signal from '../../util/Signal';
import { TypesMap, CompiledFile, CompiledNote, CompiledNotes, WritableContent } from '../../model';
import * as PMAST from '../../model/PMAST';
import * as ESTree from '../ESTree';
import * as Parse from '../Parse';
import * as Evaluate from '../Evaluate';
import * as Render from '../Render';
import * as Generate from '../Generate';
import Type from '../Type';
import Typecheck from '../Typecheck';
import * as Dyncheck from '../Dyncheck';

import makeLink from '../../components/makeLink';

function typecheckCode(
  moduleName: string,
  node: PMAST.Code,
  moduleEnv: Map<string, Type.ModuleType>,
  typeEnv: Typecheck.Env,
  exportTypes: { [s: string]: Type },
  typesMap: TypesMap,
): Typecheck.Env {
  const code = Parse.parseCodeNode(node);
  code.forEach(code => {
    typeEnv = Typecheck.synthProgram(
      moduleName,
      moduleEnv,
      code as ESTree.Program,
      typeEnv,
      exportTypes,
      typesMap
    );
  });
  return typeEnv;
}

function dyncheckCode(
  moduleName: string,
  node: PMAST.Code,
  moduleEnv: Map<string, Map<string, boolean>>,
  typeEnv: Render.TypeEnv,
  dynamicEnv: Render.DynamicEnv,
  exportDynamic: Map<string, boolean>,
): Render.DynamicEnv {
  const code = Parse.parseCodeNode(node);
  code.forEach(code => {
    dynamicEnv = Dyncheck.program(
      moduleName,
      moduleEnv,
      code as ESTree.Program,
      typeEnv,
      dynamicEnv,
      exportDynamic,
    );
  });
  return dynamicEnv;
}

function typecheckInlineCode(
  node: PMAST.InlineCode,
  env: Typecheck.Env,
  typesMap: TypesMap,
) {
  const code = Parse.parseInlineCodeNode(node);
  code.forEach(code =>
    Typecheck.check(code as ESTree.Expression, env, Type.reactNodeType, typesMap)
  );
}

export default function compileFilePm(
  file: WritableContent,
  compiledFiles: Signal<Map<string, CompiledFile>> = Signal.ok(new Map()),
  compiledNotes: Signal<CompiledNotes> = Signal.ok(new Map()),
  setSelected: (note: string) => void = (note: string) => { },
): CompiledFile {
  const moduleName = Name.nameOfPath(file.path);

  // TODO(jaked) Signal function to project from a Writable
  const nodes = (file.content as Signal.Writable<model.PMContent>).mapWritable(
      content => content.nodes,
      nodes => ({ nodes, meta: (file.content.get() as model.PMContent).meta })
  );

  // TODO(jaked)
  // we want just the bindings and imports here, but this also includes ExpressionStatements
  const codeNodes = nodes.map(nodes =>
    Immutable.List<PMAST.Code>().withMutations(codeNodes => {
      function pushCodeNodes(node: PMAST.Node) {
        if (PMAST.isCode(node)) {
          codeNodes.push(node);
        } else if (PMAST.isElement(node)) {
          node.children.forEach(pushCodeNodes);
        }
      }
      nodes.forEach(pushCodeNodes);
    })
  );

  const inlineCodeNodes = nodes.map(nodes =>
    Immutable.List<PMAST.InlineCode>().withMutations(inlineCodeNodes => {
      function pushInlineCodeNodes(node: PMAST.Node) {
        if (PMAST.isInlineCode(node)) {
          inlineCodeNodes.push(node);
        } else if (PMAST.isElement(node)) {
          node.children.forEach(pushInlineCodeNodes);
        }
      }
      nodes.forEach(pushInlineCodeNodes);
    })
  );

  const imports = codeNodes.map(codeNodes =>
    Immutable.List<string>().withMutations(imports => {
      codeNodes.forEach(node => {
        const code = Parse.parseCodeNode(node);
        code.forEach(code =>
          (code as ESTree.Program).body.forEach(node => {
            switch (node.type) {
              case 'ImportDeclaration':
                imports.push(node.source.value);
                break;
            }
          })
        );
      });
    })
  );

  // TODO(jaked) push note errors into envs so they're surfaced in editor?
  const noteEnv =
    Signal.join(imports, compiledNotes).map(([imports, compiledNotes]) => {
      const noteEnv = new Map<string, CompiledNote>();
      imports.forEach(name => {
        // TODO(jaked)
        // we do this resolution here, in Synth, and in Render
        // could rewrite or annotate the AST to do it just once
        const resolvedName = Name.rewriteResolve(compiledNotes, moduleName, name);
        if (resolvedName) {
          const note = compiledNotes.get(resolvedName) ?? bug(`expected module '${resolvedName}'`);
          noteEnv.set(resolvedName, note);
        }
      });
      return noteEnv;
    });
  const moduleTypeEnv =
    Signal.joinMap(Signal.mapMap(noteEnv, note => note.exportType));
  const moduleDynamicEnv =
    Signal.joinMap(Signal.mapMap(noteEnv, note => note.exportDynamic));
  const moduleValueEnv =
    Signal.joinMap(Signal.mapMap(noteEnv, note => note.exportValue));

  const pathParsed = Path.parse(file.path);
  const jsonPath = Path.format({ ...pathParsed, base: undefined, ext: '.json' });
  const tablePath = Path.format({ ...pathParsed, base: undefined, ext: '.table' });

  const jsonType = compiledFiles.flatMap(compiledFiles => {
    const json = compiledFiles.get(jsonPath);
    if (json)
      return json.exportType.map(exportType =>
        exportType.getFieldType('mutable')
      );
    else
      return Signal.ok(undefined);
  });
  const jsonValue = compiledFiles.flatMap(compiledFiles => {
    const json = compiledFiles.get(jsonPath);
    if (json)
      return json.exportValue.map(exportValue =>
        exportValue.get('mutable') ?? bug(`expected mutable`)
      );
    else
      return Signal.ok(undefined);
  });
  const tableType = compiledFiles.flatMap(compiledFiles => {
    const table = compiledFiles.get(tablePath);
    if (table)
      return table.exportType.map(exportType =>
        exportType.getFieldType('default')
      );
    else
      return Signal.ok(undefined);
  });
  const tableValue = compiledFiles.flatMap(compiledFiles => {
    const table = compiledFiles.get(tablePath);
    if (table)
      return table.exportValue.map(exportValue =>
        exportValue.get('default') ?? bug(`expected default`)
      );
    else
      return Signal.ok(undefined);
  });

  // TODO(jaked)
  // finer-grained deps so we don't rebuild all code e.g. when json changes
  const typecheckedCode = Signal.join(
    codeNodes,
    jsonType,
    tableType,
    moduleTypeEnv,
    moduleDynamicEnv,
  ).map(([codeNodes, jsonType, tableType, moduleTypeEnv, moduleDynamicEnv]) => {
    // TODO(jaked) pass into compileFilePm
    let typeEnv = Render.initTypeEnv;
    let dynamicEnv = Render.initDynamicEnv;

    if (jsonType) {
      typeEnv = typeEnv.set('data', jsonType);
      dynamicEnv = dynamicEnv.set('data', false);
    }
    if (tableType) {
      typeEnv = typeEnv.set('table', tableType);
      dynamicEnv = dynamicEnv.set('table', false);
    }

    const exportTypes: { [s: string]: Type.Type } = {};
    const exportDynamic: Map<string, boolean> = new Map();
    const typesMap = new Map<unknown, Type>();
    codeNodes.forEach(node => {
      typeEnv = typecheckCode(
        moduleName,
        node,
        moduleTypeEnv,
        typeEnv,
        exportTypes,
        typesMap
      );
      dynamicEnv = dyncheckCode(
        moduleName,
        node,
        moduleDynamicEnv,
        typeEnv,
        dynamicEnv,
        exportDynamic
      );
    });
    const exportType = Type.module(exportTypes);
    return { typesMap, typeEnv, exportType, dynamicEnv, exportDynamic }
  });

  // TODO(jaked)
  // re-typecheck only nodes that have changed since previous render
  // or when env changes
  const typecheckedInlineCode = Signal.join(
    typecheckedCode,
    inlineCodeNodes,
  ).map(([{ typesMap, typeEnv }, inlineCodeNodes]) => {
    // clone to avoid polluting annotations between versions
    // TODO(jaked) works fine but not very clear
    typesMap = new Map(typesMap);

    inlineCodeNodes.forEach(node =>
      typecheckInlineCode(node, typeEnv, typesMap)
    );
    const problems = [...typesMap.values()].some(t => t.kind === 'Error');
    if (problems && debug) {
      const errorAnnotations = new Map<unknown, Type>();
      typesMap.forEach((v, k) => {
        if (v.kind === 'Error')
          errorAnnotations.set(k, v);
      });
      console.log(errorAnnotations);
    }
    return { typesMap, problems }
  });

  // TODO(jaked)
  // finer-grained deps so we don't rebuild all code e.g. when json changes
  const compile = Signal.join(
    codeNodes,
    typecheckedCode,
    jsonValue,
    tableValue,
    moduleDynamicEnv,
    moduleValueEnv,
  ).map(([codeNodes, { typesMap, dynamicEnv }, jsonValue, tableValue, moduleDynamicEnv, moduleValueEnv]) => {
    // TODO(jaked) pass into compileFilePm
    let valueEnv = Render.initValueEnv;

    if (jsonValue) valueEnv = valueEnv.set('data', jsonValue);
    if (tableValue) valueEnv = valueEnv.set('table', tableValue);

    const exportValue: Map<string, Signal<unknown>> = new Map();
    codeNodes.forEach(node =>
      valueEnv = Evaluate.evaluateCodeNode(
        nodes,
        node,
        typesMap,
        moduleName,
        moduleDynamicEnv,
        moduleValueEnv,
        dynamicEnv,
        valueEnv,
        exportValue
      )
    );
    return { valueEnv, exportValue };
  });

  const Link = makeLink(moduleName, setSelected);

  // TODO(jaked)
  // re-render only nodes that have changed since previous render
  // or when env changes
  const rendered = Signal.join(
    nodes,
    compile,
    typecheckedCode,
    typecheckedInlineCode,
  ).map(([nodes, { valueEnv }, { dynamicEnv }, { typesMap }]) => {
    const nextRootId: [ number ] = [ 0 ];
    return nodes.map(node => Render.renderNode(node, typesMap, dynamicEnv, valueEnv, nextRootId, Link));
  });

  const debug = false;
  const meta = (file.content as Signal.Writable<model.PMContent>).map(content => content.meta);
  const layoutFunction = Signal.join(
   meta,
   compiledNotes,
 ).flatMap(([meta, compiledNotes]) => {
  if (meta.layout) {
    if (debug) console.log(`meta.layout`);
    const layoutModule = compiledNotes.get(meta.layout);
    if (layoutModule) {
      if (debug) console.log(`layoutModule`);
      return Signal.join(
        layoutModule.exportType,
        layoutModule.exportDynamic,
        layoutModule.exportValue,
      ).map(([exportType, exportDynamic, exportValue]) => {
        const defaultType = exportType.getFieldType('default');
        if (defaultType) {
          if (debug) console.log(`defaultType`);
          if (Type.isSubtype(defaultType, Type.layoutFunctionType)) {
            if (debug) console.log(`isSubtype`);
            const dynamic = exportDynamic.get('default') ?? bug(`expected default`);
            // TODO(jaked)
            // a dynamic layout forces the whole page to be dynamic, would that be ok?
            // also a static layout should be able to contain dynamic elements
            // but the type system doesn't capture this adequately
            if (!dynamic) {
              if (debug) console.log(`!dynamic`);
              return exportValue.get('default') ?? bug(`expected default`);
            }
          }
        }
        return undefined;
      });
    }
  }
  return Signal.ok(undefined);
 });

  // the purpose of this wrapper is to avoid remounts when `component` changes.
  // React assumes that a changed component is likely to be very different,
  // so remounts the whole tree, losing the state of stateful DOM components.
  // TODO(jaked) memoize on individual props?
  const functionComponent = React.memo<{ component, props }>(({ component, props }) =>
    component(props)
  )

 const renderedWithLayout = Signal.join(
    rendered,
    meta,
    layoutFunction,
  ).map(([rendered, meta, layoutFunction]) => {
    if (layoutFunction) {
      return React.createElement(
        functionComponent,
        { component: layoutFunction, props: { children: rendered, meta }}
      );
    } else
      return rendered
  });

  const html = renderedWithLayout.map(rendered => {
    const renderedWithContext =
      React.createElement(Render.context.Provider, { value: 'server' }, rendered)
    const html = ReactDOMServer.renderToStaticMarkup(renderedWithContext);
    const script = `<script type='module' src='${moduleName}.js'></script>`
    const headIndex = html.indexOf('</head>');
    if (headIndex === -1) {
      return `<html>
<head>
${script}
</head>
<body>
${html}
</body>
</html>`
    } else {
      return `${html.slice(0, headIndex)}${script}${html.slice(headIndex)}`;
    }
  });

  const js = Signal.join(
    nodes,
    typecheckedCode,
    typecheckedInlineCode,
  ).map(([nodes, { dynamicEnv }, { typesMap }]) => {
    return Generate.generatePm(
      nodes,
      expr => typesMap.get(expr) ?? bug(`expected type for ${JSON.stringify(expr)}`),
      dynamicEnv,
    );
  });

  return {
    ast: Signal.ok(null),
    typesMap: typecheckedInlineCode.map(({ typesMap }) => typesMap),
    problems: typecheckedInlineCode.liftToTry().map(compiled =>
      compiled.type === 'ok' ? compiled.ok.problems : true
    ),
    rendered: renderedWithLayout,

    exportType: typecheckedCode.map(({ exportType }) => exportType),
    exportValue: compile.map(({ exportValue }) => exportValue),
    exportDynamic: typecheckedCode.map(({ exportDynamic }) => exportDynamic),

    html,
    js,
  };
}
