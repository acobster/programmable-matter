import * as React from 'react';
import { Box as BoxBase } from 'rebass';
import styled from 'styled-components';
import { VariableSizeGrid } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';

const Box = styled(BoxBase)`
  border-style: solid;
  border-color: #cccccc;
  border-top-width: ${props => props.borderTopWidth}px;
  border-left-width: ${props => props.borderLeftWidth}px;
  border-right-width: 1px;
  border-bottom-width: 1px;
  padding: 6px;

  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
`;

export type Field = {
  label: string,
  accessor: (o: object) => any,
  component: React.FunctionComponent<{ lens: any }>
}

export const Record = (fields: Field[]) => {
  const cellFn = ({ rowIndex, columnIndex, style, data }) => {
    const field = fields[rowIndex];
    const borderTopWidth = rowIndex === 0 ? 1 : 0;
    const borderLeftWidth = columnIndex === 0 ? 1 : 0;

    if (columnIndex === 0) {
      return (
        <Box
          style={style}
          borderTopWidth={borderTopWidth}
          borderLeftWidth={borderLeftWidth}
        >
          {field.label}
        </Box>
      );
    } else {
      const lens = field.accessor(data);
      const Component = field.component;

      return (
        <Box
          style={style}
          borderTopWidth={borderTopWidth}
          borderLeftWidth={borderLeftWidth}
        >
          <Component lens={lens} />
        </Box>
      );
    }
  }

  return ({ object } : { object: object }) => {
    const gridFn = ({ height, width }) =>
      <VariableSizeGrid
        itemData={object}
        columnCount={2}
        rowCount={fields.length}
        columnWidth={(col) => col === 0 ? 100 : 200}
        rowHeight={(row) => 30}
        height={height}
        width={width}
      >
        {cellFn}
      </VariableSizeGrid>

    return (
      <AutoSizer>
        {gridFn}
      </AutoSizer>
    );
  }
}
