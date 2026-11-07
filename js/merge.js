/* merge.js — decides how ONE file is combined during a three-way merge.
 *
 * Git compares three versions of every file:
 *   base   – the file in the common ancestor commit (where the branches split)
 *   ours   – the file on the branch you're on (HEAD)
 *   theirs – the file on the branch you're merging in
 */
(function (global) {
  'use strict';

  // Builds the text Git writes into a file when it can't decide on its own.
  function conflictText(ours, theirs, theirLabel) {
    const block = (s) => (s === undefined || s === '' ? '' : s.endsWith('\n') ? s : s + '\n');
    return `<<<<<<< HEAD\n${block(ours)}=======\n${block(theirs)}>>>>>>> ${theirLabel}\n`;
  }

  /**
   * Three-way merge of a single file.
   * Each argument is the file's text, or `undefined` if the file doesn't exist in that version.
   * Returns { content, conflict }:
   *   content  – the merged text (undefined = the file should be deleted)
   *   conflict – true when a human has to step in
   */
  function mergeFile(base, ours, theirs, theirLabel) {
    // Both sides ended up identical (including both deleting it): nothing to decide.
    if (ours === theirs) return { content: ours, conflict: false };
    // Only one side touched the file since the split: take that side's version.
    // `undefined` flows through naturally, so a one-sided delete stays deleted.
    if (ours === base) return { content: theirs, conflict: false };
    if (theirs === base) return { content: ours, conflict: false };
    // Both changed it differently. That includes "one edited, one deleted",
    // which real Git also refuses to guess on (a modify/delete conflict).
    return { content: conflictText(ours, theirs, theirLabel), conflict: true };
  }

  global.GitMerge = { mergeFile, conflictText };
})(window);
