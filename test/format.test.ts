"use strict";

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ModeHandler } from './../src/mode/modeHandler';
import { TextEditor } from './../src/textEditor';
import { cleanUpWorkspace, setupWorkspaceWithTestProject, openFile } from './testUtils';

suite("text editor", () => {
  let modeHandler: ModeHandler;
  setup(async () => {
    await setupWorkspaceWithTestProject();
    modeHandler = new ModeHandler();
  });

  suiteTeardown(cleanUpWorkspace);

  test("test code format for JavaScript", async () => {
    await openFile("format.js");

    await modeHandler.handleMultipleKeyEvents("jj$=".split(""));
    let actualText = TextEditor.readLineAt(1);
    assert.equal(actualText, "    bar();");
  });
});
