import * as React from 'react';
import { Box, Flex } from 'rebass';
import styled from 'styled-components';

import { Editor } from './Editor';
import { Display } from './Display';

const FullHeightBox = styled(Box)`
  height: 100vh
`;

export class Main extends React.Component<any, any> {
  state = {
    content: '# Hello World'
  }

  handleChange = content => {
    this.setState({ content })
  }

  render() {
    const { content } = this.state
    return (
      <Flex>
        <FullHeightBox width={1/2}>
          <Editor content={content} onChange={this.handleChange} />
        </FullHeightBox>
        <FullHeightBox width={1/2}>
          <Display content={content} />
        </FullHeightBox>
      </Flex>
    );
  }
}
