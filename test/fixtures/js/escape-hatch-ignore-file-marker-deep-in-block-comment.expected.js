// filler line 1
// filler line 2
/**
 * This block comment starts within the 5-line window, but the actual ignore-file marker below
 * sits several lines into its body, well past the point where the window should have stopped
 * applying. The marker's own line, not the comment's start line, is what must be checked.
 * comment-fmt-ignore-file
 */
// This is a long overflowing comment that must still get
// reflowed because the marker above sits past the window.
const x = 1;
