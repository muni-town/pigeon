import React from 'react';
import { Box, Text } from 'folds';
import * as css from './styles.css';

export function AuthFooter() {
  return (
    <Box className={css.AuthFooter} justifyContent="Center" gap="400" wrap="Wrap">
      {/* <Text as="a" size="T300" href="https://cinny.in" target="_blank" rel="noreferrer">
        About
      </Text>
      <Text
        as="a"
        size="T300"
        href="https://github.com/ajbura/cinny/releases"
        target="_blank"
        rel="noreferrer"
      >
        v4.2.3
      </Text> */}
      <Text size="T300">
        Hacked into{' '}
        <a href="https://cinny.in" target="_blank" rel="noreferrer">
          Cinny{' '}
        </a>
        by{' '}
        <a href="https://bsky.app/profile/zicklag.katharos.group" target="_blank" rel="noreferrer">
          @zicklag.katharos.group{' '}
        </a>
      </Text>
      <Text size="T300">
        Powered by{' '}
        <a href="https://atproto.com" target="_blank" rel="noreferrer">
          AtProto
        </a>
        ,{' '}
        <a href="https://peerjs.com" target="_blank" rel="noreferrer">
          PeerJS,
        </a>{' '}
        &amp;{' '}
        <a href="https://earthstar-project.org/" target="_blank" rel="noreferrer">
          Earthstar
        </a>
      </Text>
    </Box>
  );
}
