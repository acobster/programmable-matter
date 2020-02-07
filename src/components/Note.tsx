import * as React from 'react';
import { Flex as BaseFlex } from 'rebass';
import styled from 'styled-components';

interface Props {
  label: string,
  expanded?: boolean,
  indent: number,
  err: boolean,
  selected: boolean;
  onClick: () => void;
  style: any;
}

const Flex = styled(BaseFlex)`
  :hover {
    cursor: pointer;
  }
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
`;

export const Note = ({ label: tag, expanded, indent, err, selected, onClick, style } : Props) => {
  const backgroundColor =
    err ?
      (selected ? '#cc8080' : '#ffc0c0') :
      (selected ? '#cccccc' : '#ffffff');
  const icon = (typeof expanded === 'undefined') ? undefined :
               expanded ? '-' : '+';
  return (
    <Flex
      padding={2}
      backgroundColor={backgroundColor}
      onClick={onClick}
      style={style}
    >
      <div style={{ minWidth: `${indent * 10}px` }} />
      <div style={{ minWidth: '10px' }}>{icon}</div>
      <div>{tag}</div>
    </Flex>
  );
};
