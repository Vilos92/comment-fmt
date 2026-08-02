export type WingSession = {
  /**
   * Leave the current wing (or dismiss a terminal state). A no-op from `none`.
   * @sideEffect Closes the socket. Replaces the URL to `/`.
   */
  leave: () => void;
};
