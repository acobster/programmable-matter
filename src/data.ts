import Immutable from 'immutable';
import React from 'react';
import Try from './util/Try';
import * as MDXHAST from './lang/mdxhast';
import * as Type from './lang/Type';

export interface Parsed {
  ast: MDXHAST.Root;
  imports: Set<string>;
}

export interface Compiled {
  exportType: Type.ModuleType;
  exportValue: { [s: string]: any };
  rendered: React.ReactNode;
}

export interface Note {
  tag: string;
  content: string;
  version: number;
  parsed?: Try<Parsed>;
  compiled?: Try<Compiled>;
}

export type Notes = Immutable.Map<string, Note>;
