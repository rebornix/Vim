import { VimSpecialCommands, VimState, SearchState, SearchDirection, ReplaceState } from './../mode/modeHandler';
import { ModeName } from './../mode/mode';
import { VisualBlockInsertionType } from './../mode/modeVisualBlock';
import { TextEditor } from './../textEditor';
import { Register, RegisterMode } from './../register/register';
import { NumericString } from './../number/numericString';
import { Position } from './../motion/position';
import { PairMatcher } from './../matching/matcher';
import { QuoteMatcher } from './../matching/quoteMatcher';
import { TagMatcher } from './../matching/tagMatcher';
import { Tab, TabCommand } from './../cmd_line/commands/tab';
import { Configuration } from './../configuration/configuration';
import * as vscode from 'vscode';
import * as clipboard from 'copy-paste';

const controlKeys: string[] = [
  "ctrl",
  "alt",
  "shift",
  "esc",
  "delete",
  "left",
  "right",
  "up",
  "down"
];

const compareKeypressSequence = function (one: string[], two: string[]): boolean {
  const containsControlKey = (s: string): boolean => {
    for (const controlKey of controlKeys) {
      if (s.indexOf(controlKey!) !== -1) {
        return true;
      }
    }

    return false;
  };

  const isSingleNumber = (s: string): boolean => {
    return s.length === 1 && "1234567890".indexOf(s) > -1;
  };

  if (one.length !== two.length) {
    return false;
  }

  for (let i = 0, j = 0; i < one.length; i++, j++) {
    const left = one[i], right = two[j];

    if (left  === "<any>") { continue; }
    if (right === "<any>") { continue; }

    if (left  === "<number>" && isSingleNumber(right)) { continue; }
    if (right === "<number>" && isSingleNumber(left) ) { continue; }

    if (left  === "<character>" && !containsControlKey(right)) { continue; }
    if (right === "<character>" && !containsControlKey(left)) { continue; }

    if (left !== right) { return false; }
  }

  return true;
};

/**
 * The result of a (more sophisticated) Movement.
 */
export interface IMovement {
  start        : Position;
  stop         : Position;

  /**
   * Whether this motion succeeded. Some commands, like fx when 'x' can't be found,
   * will not move the cursor. Furthermore, dfx won't delete *anything*, even though
   * deleting to the current character would generally delete 1 character.
   */
  failed?      : boolean;

  // It /so/ annoys me that I have to put this here.
  registerMode?: RegisterMode;
}

export function isIMovement(o: IMovement | Position): o is IMovement {
    return (o as IMovement).start !== undefined &&
           (o as IMovement).stop  !== undefined;
}

export class BaseAction {
  /**
   * Can this action be paired with an operator (is it like w in dw)? All
   * BaseMovements can be, and some more sophisticated commands also can be.
   */
  isMotion = false;

  canBeRepeatedWithDot = false;

  /**
   * Modes that this action can be run in.
   */
  public modes: ModeName[];

  /**
   * The sequence of keys you use to trigger the action.
   */
  public keys: string[];

  public mustBeFirstKey = false;

  /**
   * The keys pressed at the time that this action was triggered.
   */
  public keysPressed: string[] = [];

  /**
   * Is this action valid in the current Vim state?
   */
  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    if (this.modes.indexOf(vimState.currentMode) === -1) { return false; }
    if (!compareKeypressSequence(this.keys, keysPressed)) { return false; }
    if (vimState.recordedState.actionsRun.length > 0 &&
        this.mustBeFirstKey) { return false; }
    if (this instanceof BaseOperator && vimState.recordedState.operator) { return false; }

    return true;
  }

  /**
   * Could the user be in the process of doing this action.
   */
  public couldActionApply(vimState: VimState, keysPressed: string[]): boolean {
    if (this.modes.indexOf(vimState.currentMode) === -1) { return false; }
    if (!compareKeypressSequence(this.keys.slice(0, keysPressed.length), keysPressed)) { return false; }
    if (vimState.recordedState.actionsRun.length > 0 &&
        this.mustBeFirstKey) { return false; }
    if (this instanceof BaseOperator && vimState.recordedState.operator) { return false; }

    return true;
  }

  public toString(): string {
    return this.keys.join("");
  }
}

/**
 * A movement is something like 'h', 'k', 'w', 'b', 'gg', etc.
 */
export abstract class BaseMovement extends BaseAction {
  modes = [
    ModeName.Normal,
    ModeName.Visual,
    ModeName.VisualLine,
    ModeName.VisualBlock];

  isMotion = true;

  canBePrefixedWithCount = false;

  /**
   * Whether we should change desiredColumn in VimState.
   */
  public doesntChangeDesiredColumn = false;

  /**
   * This is for commands like $ which force the desired column to be at
   * the end of even the longest line.
   */
  public setsDesiredColumnToEOL = false;

  /**
   * Run the movement a single time.
   *
   * Generally returns a new Position. If necessary, it can return an IMovement instead.
   */
  public async execAction(position: Position, vimState: VimState): Promise<Position | IMovement> {
    throw new Error("Not implemented!");
   }

  /**
   * Run the movement in an operator context a single time.
   *
   * Some movements operate over different ranges when used for operators.
   */
  public async execActionForOperator(position: Position,  vimState: VimState): Promise<Position | IMovement> {
    return await this.execAction(position, vimState);
  }

  /**
   * Run a movement count times.
   *
   * count: the number prefix the user entered, or 0 if they didn't enter one.
   */
  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
      let recordedState = vimState.recordedState;
      let result: Position | IMovement = new Position(0, 0);  // bogus init to satisfy typechecker

      if (count < 1) {
          count = 1;
      } else if (count > 99999) {
          count = 99999;
      }

      for (let i = 0; i < count; i++) {
          const firstIteration = (i === 0);
          const lastIteration = (i === count - 1);
          const temporaryResult = (recordedState.operator && lastIteration) ?
              await this.execActionForOperator(position, vimState) :
              await this.execAction           (position, vimState);

          if (temporaryResult instanceof Position) {
            result = temporaryResult;
            position = temporaryResult;
          } else if (isIMovement(temporaryResult)) {
            if (result instanceof Position) {
              result = {
                start  : new Position(0, 0),
                stop   : new Position(0, 0),
                failed : false
              };
            }

            result.failed = result.failed || temporaryResult.failed;

            if (firstIteration) {
              (result as IMovement).start = temporaryResult.start;
            }

            if (lastIteration) {
              (result as IMovement).stop = temporaryResult.stop;
            } else {
              position = temporaryResult.stop.getRightThroughLineBreaks();
            }
          }
      }

      return result;
  }
}

/**
 * A command is something like <escape>, :, v, i, etc.
 */
export abstract class BaseCommand extends BaseAction {
  /**
   * If isCompleteAction is true, then triggering this command is a complete action -
   * that means that we'll go and try to run it.
   */
  isCompleteAction = true;

  canBePrefixedWithCount = false;

  canBeRepeatedWithDot = false;

  /**
   * Run the command a single time.
   */
  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    throw new Error("Not implemented!");
  }

  /**
   * Run the command the number of times VimState wants us to.
   */
  public async execCount(position: Position, vimState: VimState): Promise<VimState> {
    let timesToRepeat = this.canBePrefixedWithCount ? vimState.recordedState.count || 1 : 1;

    for (let i = 0; i < timesToRepeat; i++) {
      vimState = await this.exec(position, vimState);
    }

    return vimState;
  }
}

export class BaseOperator extends BaseAction {
    canBeRepeatedWithDot = true;

    /**
     * Run this operator on a range, returning the new location of the cursor.
     */
    run(vimState: VimState, start: Position, stop: Position): Promise<VimState> {
      throw new Error("You need to override this!");
    }
}

export enum KeypressState {
  WaitingOnKeys,
  NoPossibleMatch
}

export class Actions {

  /**
   * Every Vim action will be added here with the @RegisterAction decorator.
   */
  public static allActions: { type: typeof BaseAction, action: BaseAction }[] = [];

  /**
   * Gets the action that should be triggered given a key
   * sequence.
   *
   * If there is a definitive action that matched, returns that action.
   *
   * If an action could potentially match if more keys were to be pressed, returns true. (e.g.
   * you pressed "g" and are about to press "g" action to make the full action "gg".)
   *
   * If no action could ever match, returns false.
   */
  public static getRelevantAction(keysPressed: string[], vimState: VimState): BaseAction | KeypressState {
    let couldPotentiallyHaveMatch = false;

    for (const thing of Actions.allActions) {
      const { type, action } = thing!;

      if (action.doesActionApply(vimState, keysPressed)) {
        const result = new type();

        result.keysPressed = vimState.recordedState.actionKeys.slice(0);

        return result;
      }

      if (action.couldActionApply(vimState, keysPressed)) {
        couldPotentiallyHaveMatch = true;
      }
    }

    return couldPotentiallyHaveMatch ? KeypressState.WaitingOnKeys : KeypressState.NoPossibleMatch;
  }
}

export function RegisterAction(action: typeof BaseAction): void {
  Actions.allActions.push({ type: action, action: new action() });
}





// begin actions










@RegisterAction
class CommandNumber extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = ["<number>"];
  isCompleteAction = false;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const number = parseInt(this.keysPressed[0], 10);

    vimState.recordedState.count = vimState.recordedState.count * 10 + number;

    return vimState;
  }

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    const isZero = keysPressed[0] === "0";

    return super.doesActionApply(vimState, keysPressed) &&
      ((isZero && vimState.recordedState.count > 0) || !isZero);
  }

  public couldActionApply(vimState: VimState, keysPressed: string[]): boolean {
    const isZero = keysPressed[0] === "0";

    return super.couldActionApply(vimState, keysPressed) &&
      ((isZero && vimState.recordedState.count > 0) || !isZero);
  }
}

@RegisterAction
class CommandRegister extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = ["\"", "<character>"];
  isCompleteAction = false;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const register = this.keysPressed[1];
    vimState.recordedState.registerName = register;
    return vimState;
  }

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    const register = keysPressed[1];

    return super.doesActionApply(vimState, keysPressed) && Register.isValidRegister(register);
  }

  public couldActionApply(vimState: VimState, keysPressed: string[]): boolean {
    const register = keysPressed[1];

    return super.couldActionApply(vimState, keysPressed) && Register.isValidRegister(register);
  }
}

@RegisterAction
class CommandEsc extends BaseCommand {
  modes = [
    ModeName.Insert,
    ModeName.Visual,
    ModeName.VisualLine,
    ModeName.VisualBlockInsertMode,
    ModeName.VisualBlock,
    ModeName.SearchInProgressMode,
    ModeName.Replace
  ];
  keys = ["<escape>"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    if (vimState.currentMode !== ModeName.Visual &&
        vimState.currentMode !== ModeName.VisualLine) {
      vimState.cursorPosition = position.getLeft();
    }

    if (vimState.currentMode === ModeName.SearchInProgressMode) {
      if (vimState.searchState) {
        vimState.cursorPosition = vimState.searchState.searchCursorStartPosition;
      }
    }

    vimState.currentMode = ModeName.Normal;

    return vimState;
  }
}

@RegisterAction
class CommandCtrlOpenBracket extends CommandEsc {
  keys = ["ctrl+["];
}

@RegisterAction
class CommandCtrlW extends BaseCommand {
  modes = [ModeName.Insert];
  keys = ["ctrl+w"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const wordBegin = position.getWordLeft();
    await TextEditor.delete(new vscode.Range(wordBegin, position));

    vimState.cursorPosition = wordBegin;

    return vimState;
  }
}

@RegisterAction
class CommandCtrlE extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["ctrl+e"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    await vscode.commands.executeCommand("scrollLineDown");

    return vimState;
  }
}

@RegisterAction
class CommandCtrlY extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["ctrl+y"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    await vscode.commands.executeCommand("scrollLineUp");

    return vimState;
  }
}

@RegisterAction
class CommandCtrlC extends CommandEsc {
  keys = ["ctrl+c"];
}

@RegisterAction
class CommandInsertAtCursor extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["i"];
  mustBeFirstKey = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.Insert;

    return vimState;
  }
}

@RegisterAction
class CommandReplacecAtCursor extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["R"];
  mustBeFirstKey = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.Replace;
    vimState.replaceState = new ReplaceState(position);

    return vimState;
  }
}

@RegisterAction
class CommandReplaceInReplaceMode extends BaseCommand {
  modes = [ModeName.Replace];
  keys = ["<character>"];
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const char = this.keysPressed[0];

    const replaceState = vimState.replaceState!;

    if (char === "<backspace>") {
      if (position.isBeforeOrEqual(replaceState.replaceCursorStartPosition)) {
        vimState.cursorPosition = position.getLeft();
        vimState.cursorStartPosition = position.getLeft();
      } else if (position.line > replaceState.replaceCursorStartPosition.line ||
                 position.character > replaceState.originalChars.length) {
        const newPosition = await TextEditor.backspace(position);
        vimState.cursorPosition = newPosition;
        vimState.cursorStartPosition = newPosition;
      } else {
        await TextEditor.replace(new vscode.Range(position.getLeft(), position), replaceState.originalChars[position.character - 1]);
        const leftPosition = position.getLeft();
        vimState.cursorPosition = leftPosition;
        vimState.cursorStartPosition = leftPosition;
      }
    } else {
      if (!position.isLineEnd()) {
        vimState = await new DeleteOperator().run(vimState, position, position);
      }
      await TextEditor.insertAt(char, position);

      vimState.cursorStartPosition = Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.start);
      vimState.cursorPosition = Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.start);
    }

    vimState.currentMode = ModeName.Replace;
    return vimState;
  }
}

class ArrowsInReplaceMode extends BaseMovement {
  modes = [ModeName.Replace];
  keys: string[];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    let newPosition: Position = position;

    switch (this.keys[0]) {
      case "<up>":
        newPosition = await new MoveUpArrow().execAction(position, vimState);
        break;
      case "<down>":
        newPosition = await new MoveDownArrow().execAction(position, vimState);
        break;
      case "<left>":
        newPosition = await new MoveLeftArrow().execAction(position, vimState);
        break;
      case "<right>":
        newPosition = await new MoveRightArrow().execAction(position, vimState);
        break;
      default:
        break;
    }
    vimState.replaceState = new ReplaceState(newPosition);
    return newPosition;
  }
}

@RegisterAction
class UpArrowInReplaceMode extends ArrowsInReplaceMode {
  keys = ["<up>"];
}

@RegisterAction
class DownArrowInReplaceMode extends ArrowsInReplaceMode {
  keys = ["<down>"];
}

@RegisterAction
class LeftArrowInReplaceMode extends ArrowsInReplaceMode {
  keys = ["<left>"];
}

@RegisterAction
class RightArrowInReplaceMode extends ArrowsInReplaceMode {
  keys = ["<right>"];
}

@RegisterAction
class CommandInsertInSearchMode extends BaseCommand {
  modes = [ModeName.SearchInProgressMode];
  keys = ["<any>"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const key = this.keysPressed[0];
    const searchState = vimState.searchState!;

    // handle special keys first
    if (key === "<backspace>") {
      searchState.searchString = searchState.searchString.slice(0, -1);
    } else if (key === "\n") {
      vimState.currentMode = ModeName.Normal;
      vimState.cursorPosition = searchState.getNextSearchMatchPosition(searchState.searchCursorStartPosition).pos;

      return vimState;
    } else if (key === "<escape>") {
      vimState.currentMode = ModeName.Normal;
      vimState.searchState = undefined;

      return vimState;
    } else if (key === "ctrl+v") {
      const text = await new Promise<string>((resolve, reject) =>
        clipboard.paste((err, text) => err ? reject(err) : resolve(text))
      );

      searchState.searchString += text;
    } else {
      searchState.searchString += this.keysPressed[0];
    }

    // console.log(vimState.searchString); (TODO: Show somewhere!)

    vimState.cursorPosition = searchState.getNextSearchMatchPosition(searchState.searchCursorStartPosition).pos;

    return vimState;
  }
}

@RegisterAction
class CommandNextSearchMatch extends BaseMovement {
  keys = ["n"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    const searchState = vimState.searchState;

    if (!searchState || searchState.searchString === "") {
      return position;
    }

    return searchState.getNextSearchMatchPosition(vimState.cursorPosition).pos;
  }
}

@RegisterAction
class CommandStar extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = ["*"];
  isMotion = true;
  canBePrefixedWithCount = true;

  public static GetWordAtPosition(position: Position): string {
    const start = position.getWordLeft(true);
    const end   = position.getCurrentWordEnd(true).getRight();

    return TextEditor.getText(new vscode.Range(start, end));
  }

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const currentWord = CommandStar.GetWordAtPosition(position);

    vimState.searchState = new SearchState(SearchDirection.Forward, vimState.cursorPosition, currentWord);

    do {
      vimState.cursorPosition = vimState.searchState.getNextSearchMatchPosition(vimState.cursorPosition).pos;
    } while (CommandStar.GetWordAtPosition(vimState.cursorPosition) !== currentWord);

    return vimState;
  }
}

@RegisterAction
class CommandHash extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = ["#"];
  isMotion = true;
  canBePrefixedWithCount = true;

  public static GetWordAtPosition(position: Position): string {
    const start = position.getWordLeft(true);
    const end   = position.getCurrentWordEnd(true).getRight();

    return TextEditor.getText(new vscode.Range(start, end));
  }

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const currentWord = CommandStar.GetWordAtPosition(position);

    vimState.searchState = new SearchState(SearchDirection.Backward, vimState.cursorPosition, currentWord);

    // hack start
    // temporary fix for https://github.com/VSCodeVim/Vim/issues/569
    let text = TextEditor.getText(new vscode.Range(vimState.cursorPosition, vimState.cursorPosition.getRight()));
    if (text === " ") {
      return vimState;
    }
    // hack end

    do {
      // use getWordLeft() on position to start at the beginning of the word.
      // this ensures that any matches happen ounside of the word currently selected,
      // which are the desired semantics for this motion.
      vimState.cursorPosition = vimState.searchState.getNextSearchMatchPosition(vimState.cursorPosition.getWordLeft()).pos;
    } while (CommandStar.GetWordAtPosition(vimState.cursorPosition) !== currentWord);

    return vimState;
  }
}

@RegisterAction
class CommandPreviousSearchMatch extends BaseMovement {
  keys = ["N"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    const searchState = vimState.searchState;

    if (!searchState || searchState.searchString === "") {
      return position;
    }

    return searchState.getNextSearchMatchPosition(vimState.cursorPosition, -1).pos;
  }
}

@RegisterAction
class CommandInsertInInsertMode extends BaseCommand {
  modes = [ModeName.Insert];
  keys = ["<character>"];

  // TODO - I am sure this can be improved.
  // The hard case is . where we have to track cursor pos since we don't
  // update the view
  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const char   = this.keysPressed[this.keysPressed.length - 1];

    if (char === "<backspace>") {
      const newPosition = await TextEditor.backspace(position);

      vimState.cursorPosition = newPosition;
      vimState.cursorStartPosition = newPosition;
    } else {
      await TextEditor.insert(char, vimState.cursorPosition);

      vimState.cursorStartPosition = Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.start);
      vimState.cursorPosition = Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.start);
    }

    return vimState;
  }


  public toString(): string {
    return this.keysPressed[this.keysPressed.length - 1];
  }
}

@RegisterAction
export class CommandSearchForwards extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["/"];
  isMotion = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.searchState = new SearchState(SearchDirection.Forward, vimState.cursorPosition);
    vimState.currentMode = ModeName.SearchInProgressMode;

    return vimState;
  }
}

@RegisterAction
export class CommandSearchBackwards extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["?"];
  isMotion = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.searchState = new SearchState(SearchDirection.Backward, vimState.cursorPosition);
    vimState.currentMode = ModeName.SearchInProgressMode;

    return vimState;
  }
}

@RegisterAction
class CommandFormatCode extends BaseCommand {
  modes = [ModeName.Visual, ModeName.VisualLine];
  keys = ["="];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    await vscode.commands.executeCommand("editor.action.format");
    let line = vimState.cursorStartPosition.line;

    if (vimState.cursorStartPosition.isAfter(vimState.cursorPosition)) {
      line = vimState.cursorPosition.line;
    }

    let newCursorPosition = new Position(line, 0);
    vimState.cursorPosition = newCursorPosition;
    vimState.cursorStartPosition = newCursorPosition;
    vimState.currentMode = ModeName.Normal;
    return vimState;
  }
}

@RegisterAction
export class DeleteOperator extends BaseOperator {
    public keys = ["d"];
    public modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];

    /**
     * Deletes from the position of start to 1 past the position of end.
     */
    public async delete(start: Position, end: Position, currentMode: ModeName,
                        registerMode: RegisterMode, vimState: VimState, yank = true): Promise<Position> {
        if (registerMode === RegisterMode.LineWise) {
          start = start.getLineBegin();
          end   = end.getLineEnd();
        }

        end = new Position(end.line, end.character + 1);

        const isOnLastLine = end.line === TextEditor.getLineCount() - 1;

        // Vim does this weird thing where it allows you to select and delete
        // the newline character, which it places 1 past the last character
        // in the line. Here we interpret a character position 1 past the end
        // as selecting the newline character.
        if (end.character === TextEditor.getLineAt(end).text.length + 1) {
          end = end.getDown(0);
        }

        // If we delete linewise to the final line of the document, we expect the line
        // to be removed. This is actually a special case because the newline
        // character we've selected to delete is the newline on the end of the document,
        // but we actually delete the newline on the second to last line.

        // Just writing about this is making me more confused. -_-
        if (isOnLastLine &&
            start.line !== 0 &&
            registerMode === RegisterMode.LineWise) {
          start = start.getPreviousLineBegin().getLineEnd();
        }

        let text = vscode.window.activeTextEditor.document.getText(new vscode.Range(start, end));

        if (registerMode === RegisterMode.LineWise) {
          text = text.slice(0, -1); // slice final newline in linewise mode - linewise put will add it back.
        }

        if (yank) {
          Register.put(text, vimState);
        }

        await TextEditor.delete(new vscode.Range(start, end));

        let resultingPosition: Position;

        if (currentMode === ModeName.Visual) {
          resultingPosition = Position.EarlierOf(start, end);
        }

        if (start.character >= TextEditor.getLineAt(start).text.length) {
          resultingPosition = start.getLeft();
        } else {
          resultingPosition = start;
        }

        if (registerMode === RegisterMode.LineWise) {
          resultingPosition = resultingPosition.getLineBegin();
        }

        return resultingPosition;
    }

    public async run(vimState: VimState, start: Position, end: Position, yank = true): Promise<VimState> {
        const result = await this.delete(start, end, vimState.currentMode, vimState.effectiveRegisterMode(), vimState, yank);

        vimState.currentMode = ModeName.Normal;
        vimState.cursorPosition = result;

        return vimState;
    }
}

@RegisterAction
export class DeleteOperatorVisual extends BaseOperator {
    public keys = ["D"];
    public modes = [ModeName.Visual, ModeName.VisualLine];

    public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
      return await new DeleteOperator().run(vimState, start, end);
    }
}

@RegisterAction
export class YankOperator extends BaseOperator {
    public keys = ["y"];
    public modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
    canBeRepeatedWithDot = false;

    public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
      const originalMode = vimState.currentMode;
        if (start.compareTo(end) <= 0) {
          end = new Position(end.line, end.character + 1);
        } else {
          const tmp = start;
          start = end;
          end = tmp;

          end = new Position(end.line, end.character + 1);
        }

        let text = TextEditor.getText(new vscode.Range(start, end));

        // If we selected the newline character, add it as well.
        if (vimState.currentMode === ModeName.Visual &&
            end.character === TextEditor.getLineAt(end).text.length + 1) {
          text = text + "\n";
        }

        Register.put(text, vimState);

        vimState.currentMode = ModeName.Normal;

      if (originalMode === ModeName.Normal) {
        vimState.cursorPosition = vimState.cursorPositionJustBeforeAnythingHappened;
      } else {
        vimState.cursorPosition = start;
      }

        return vimState;
    }
}

@RegisterAction
export class ShiftYankOperatorVisual extends BaseOperator {
    public keys = ["Y"];
    public modes = [ModeName.Visual];

    public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
      return await new YankOperator().run(vimState, start, end);
    }
}

@RegisterAction
export class DeleteOperatorXVisual extends BaseOperator {
    public keys = ["x"];
    public modes = [ModeName.Visual, ModeName.VisualLine];

    public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
      return await new DeleteOperator().run(vimState, start, end);
    }
}

@RegisterAction
export class ChangeOperatorSVisual extends BaseOperator {
    public keys = ["s"];
    public modes = [ModeName.Visual, ModeName.VisualLine];

    public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
      return await new ChangeOperator().run(vimState, start, end);
    }
}


@RegisterAction
export class UpperCaseOperator extends BaseOperator {
    public keys = ["U"];
    public modes = [ModeName.Visual, ModeName.VisualLine];

    public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
      const range = new vscode.Range(start, new Position(end.line, end.character + 1));
      let text = vscode.window.activeTextEditor.document.getText(range);

      await TextEditor.replace(range, text.toUpperCase());

      vimState.currentMode = ModeName.Normal;
      vimState.cursorPosition = start;

      return vimState;
    }
}

@RegisterAction
export class UpperCaseWithMotion extends UpperCaseOperator {
  public keys = ["g", "U"];
  public modes = [ModeName.Normal];
}

@RegisterAction
export class LowerCaseOperator extends BaseOperator {
    public keys = ["u"];
    public modes = [ModeName.Visual, ModeName.VisualLine];

    public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
      const range = new vscode.Range(start, new Position(end.line, end.character + 1));
      let text = vscode.window.activeTextEditor.document.getText(range);

      await TextEditor.replace(range, text.toLowerCase());

      vimState.currentMode = ModeName.Normal;
      vimState.cursorPosition = start;

      return vimState;
    }
}

@RegisterAction
export class LowerCaseWithMotion extends LowerCaseOperator {
  public keys = ["g", "u"];
  public modes = [ModeName.Normal];
}

@RegisterAction
export class MarkCommand extends BaseCommand {
  keys = ["m", "<character>"];
  modes = [ModeName.Normal];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const markName = this.keysPressed[1];

    vimState.historyTracker.addMark(position, markName);

    return vimState;
  }
}

@RegisterAction
export class MarkMovementBOL extends BaseMovement {
  keys = ["'", "<character>"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    const markName = this.keysPressed[1];
    const mark = vimState.historyTracker.getMark(markName);

    return mark.position.getFirstLineNonBlankChar();
  }
}

@RegisterAction
export class MarkMovement extends BaseMovement {
  keys = ["`", "<character>"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    const markName = this.keysPressed[1];
    const mark = vimState.historyTracker.getMark(markName);

    return mark.position;
  }
}

@RegisterAction
export class ChangeOperator extends BaseOperator {
    public keys = ["c"];
    public modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];

    public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
        const isEndOfLine = end.character === TextEditor.getLineAt(end).text.length - 1;
        let state = vimState;

        // If we delete to EOL, the block cursor would end on the final character,
        // which means the insert cursor would be one to the left of the end of
        // the line.
        if (Position.getLineLength(TextEditor.getLineAt(start).lineNumber) !== 0) {
          state = await new DeleteOperator().run(vimState, start, end);
        }
        state.currentMode = ModeName.Insert;

        if (isEndOfLine) {
          state.cursorPosition = state.cursorPosition.getRight();
        }

        return state;
    }
}

@RegisterAction
export class PutCommand extends BaseCommand {
    keys = ["p"];
    modes = [ModeName.Normal];
    canBePrefixedWithCount = true;
    canBeRepeatedWithDot = true;

    public async exec(position: Position, vimState: VimState, after: boolean = false, adjustIndent: boolean = false): Promise<VimState> {
        const register = await Register.get(vimState);
        const dest = after ? position : position.getRight();
        let text = register.text;

        if (typeof text === "object") {
          return await this.execVisualBlockPaste(text, position, vimState, after);
        }

        if (register.registerMode === RegisterMode.CharacterWise) {
          await TextEditor.insertAt(text, dest);
        } else {
          if (adjustIndent) {
            // Adjust indent to current line
            let indentationWidth = TextEditor.getIndentationLevel(TextEditor.getLineAt(position).text);
            let firstLineIdentationWidth = TextEditor.getIndentationLevel(text.split('\n')[0]);

            text = text.split('\n').map(line => {
              let currentIdentationWidth = TextEditor.getIndentationLevel(line);
              let newIndentationWidth = currentIdentationWidth - firstLineIdentationWidth + indentationWidth;

              return TextEditor.setIndentationLevel(line, newIndentationWidth);
            }).join('\n');
          }

          if (after) {
            await TextEditor.insertAt(text + "\n", dest.getLineBegin());
          } else {
            await TextEditor.insertAt("\n" + text, dest.getLineEnd());
          }
        }

        // More vim weirdness: If the thing you're pasting has a newline, the cursor
        // stays in the same place. Otherwise, it moves to the end of what you pasted.

        if (register.registerMode === RegisterMode.LineWise) {
          vimState.cursorPosition = new Position(dest.line + 1, 0);
        } else {
          if (text.indexOf("\n") === -1) {
            vimState.cursorPosition = new Position(dest.line, Math.max(dest.character + text.length - 1, 0));
          } else {
            vimState.cursorPosition = dest;
          }
        }

        vimState.currentRegisterMode = register.registerMode;
        return vimState;
    }

    private async execVisualBlockPaste(block: string[], position: Position, vimState: VimState, after: boolean): Promise<VimState> {
      if (after) {
        position = position.getRight();
      }

      // Add empty lines at the end of the document, if necessary.
      let linesToAdd = Math.max(0, block.length - (TextEditor.getLineCount() - position.line) + 1);

      if (linesToAdd > 0) {
        await TextEditor.insertAt(Array(linesToAdd).join("\n"),
          new Position(
            TextEditor.getLineCount() - 1,
            TextEditor.getLineAt(new Position(TextEditor.getLineCount() - 1, 0)).text.length
          )
        );
      }

      // paste the entire block.
      for (let lineIndex = position.line; lineIndex < position.line + block.length; lineIndex++) {
        const line = block[lineIndex - position.line];
        const insertPos = new Position(
          lineIndex,
          Math.min(position.character, TextEditor.getLineAt(new Position(lineIndex, 0)).text.length)
        );

        await TextEditor.insertAt(line, insertPos);
      }

      vimState.currentRegisterMode = RegisterMode.FigureItOutFromCurrentMode;
      return vimState;
    }

    public async execCount(position: Position, vimState: VimState): Promise<VimState> {
      const result = await super.execCount(position, vimState);

      if (vimState.effectiveRegisterMode() === RegisterMode.LineWise) {
        result.cursorPosition = new Position(position.line + 1, 0).getFirstLineNonBlankChar();
      }

      return result;
    }
}

@RegisterAction
export class GPutCommand extends BaseCommand {
  keys = ["g", "p"];
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  canBePrefixedWithCount = true;
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const result = await new PutCommand().exec(position, vimState);

    return result;
  }

  public async execCount(position: Position, vimState: VimState): Promise<VimState> {
    const register = await Register.get(vimState);

    let addedLinesCount: number;

    if (typeof register.text === "object") { // visual block mode
      addedLinesCount = register.text.length * vimState.recordedState.count;
    } else {
      addedLinesCount = register.text.split('\n').length;
    }

    const result = await super.execCount(position, vimState);

    if (vimState.effectiveRegisterMode() === RegisterMode.LineWise) {
      let lastAddedLine = new Position(position.line + addedLinesCount, 0);

      if (TextEditor.isLastLine(lastAddedLine)) {
        result.cursorPosition = lastAddedLine.getLineBegin();
      } else {
        result.cursorPosition = lastAddedLine.getLineEnd().getRightThroughLineBreaks();
      }
    }

      return result;
    }
}

@RegisterAction
export class PutWithIndentCommand extends BaseCommand {
    keys = ["]", "p"];
    modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
    canBePrefixedWithCount = true;
    canBeRepeatedWithDot = true;

    public async exec(position: Position, vimState: VimState): Promise<VimState> {
      const result = await new PutCommand().exec(position, vimState, false, true);
      return result;
    }

    public async execCount(position: Position, vimState: VimState): Promise<VimState> {
      const result = await super.execCount(position, vimState);

      if (vimState.effectiveRegisterMode() === RegisterMode.LineWise) {
        result.cursorPosition = new Position(position.line + 1, 0).getFirstLineNonBlankChar();
      }

      return result;
    }
}

@RegisterAction
export class PutCommandVisual extends BaseCommand {
  keys = ["p"];
  modes = [ModeName.Visual, ModeName.VisualLine];
  canBePrefixedWithCount = true;
  canBePrefixedWithDot = true;

  public async exec(position: Position, vimState: VimState, after: boolean = false): Promise<VimState> {
    const result = await new DeleteOperator().run(vimState, vimState.cursorStartPosition, vimState.cursorPosition, false);

    return await new PutCommand().exec(result.cursorPosition, result, true);
  }

  // TODO - execWithCount
}

@RegisterAction
export class PutCommandVisualCapitalP extends PutCommandVisual {
  keys = ["P"];
}

@RegisterAction
class IndentOperator extends BaseOperator {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = [">"];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    vscode.window.activeTextEditor.selection = new vscode.Selection(start, end);

    await vscode.commands.executeCommand("editor.action.indentLines");

    vimState.currentMode     = ModeName.Normal;
    vimState.cursorPosition = start.getFirstLineNonBlankChar();

    return vimState;
  }
}

@RegisterAction
class OutdentOperator extends BaseOperator {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = ["<"];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    vscode.window.activeTextEditor.selection = new vscode.Selection(start, end);

    await vscode.commands.executeCommand("editor.action.outdentLines");
    vimState.currentMode  = ModeName.Normal;
    vimState.cursorPosition = vimState.cursorStartPosition;

    return vimState;
  }
}


@RegisterAction
export class PutBeforeCommand extends BaseCommand {
    public keys = ["P"];
    public modes = [ModeName.Normal];

    public async exec(position: Position, vimState: VimState): Promise<VimState> {
        const result = await new PutCommand().exec(position, vimState, true);

        if (vimState.effectiveRegisterMode() === RegisterMode.LineWise) {
          result.cursorPosition = result.cursorPosition.getPreviousLineBegin();
        }

        return result;
    }
}

@RegisterAction
export class GPutBeforeCommand extends BaseCommand {
  keys = ["g", "P"];
  modes = [ModeName.Normal];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const result = await new PutCommand().exec(position, vimState, true);
    const register = await Register.get(vimState);
    let addedLinesCount: number;

    if (typeof register.text === "object") { // visual block mode
      addedLinesCount = register.text.length * vimState.recordedState.count;
    } else {
      addedLinesCount = register.text.split('\n').length;
    }

    if (vimState.effectiveRegisterMode() === RegisterMode.LineWise) {
      result.cursorPosition = new Position(position.line + addedLinesCount, 0);
    }

    return result;
  }
}

@RegisterAction
export class PutBeforeWithIndentCommand extends BaseCommand {
    keys = ["[", "p"];
    modes = [ModeName.Normal];

    public async exec(position: Position, vimState: VimState): Promise<VimState> {
      const result = await new PutCommand().exec(position, vimState, true, true);

      if (vimState.effectiveRegisterMode() === RegisterMode.LineWise) {
        result.cursorPosition = result.cursorPosition.getPreviousLineBegin().getFirstLineNonBlankChar();
      }

      return result;
    }
}

@RegisterAction
class CommandShowCommandLine extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = [":"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.commandAction = VimSpecialCommands.ShowCommandLine;

    if (vimState.currentMode === ModeName.Normal) {
      vimState.commandInitialText = "";
    } else {
      vimState.commandInitialText = "'<,'>";
    }

    return vimState;
  }
}

@RegisterAction
class CommandDot extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["."];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.commandAction = VimSpecialCommands.Dot;

    return vimState;
  }
}

abstract class CommandFold extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  commandName: string;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    await vscode.commands.executeCommand(this.commandName);
    vimState.currentMode = ModeName.Normal;
    return vimState;
  }
}

@RegisterAction
class CommandCloseFold extends CommandFold {
  keys = ["z", "c"];
  commandName = "editor.fold";
  canBePrefixedWithCount = true;

  public async execCount(position: Position, vimState: VimState): Promise<VimState> {
    let count = this.canBePrefixedWithCount ? vimState.recordedState.count || 1 : 1;
    await vscode.commands.executeCommand(this.commandName, { levels: count});
    vimState.currentMode = ModeName.Normal;
    return vimState;
  }
}

@RegisterAction
class CommandCloseAllFolds extends CommandFold {
  keys = ["z", "M"];
  commandName = "editor.foldAll";
}

@RegisterAction
class CommandOpenFold extends CommandFold {
  keys = ["z", "o"];
  commandName = "editor.unfold";
  canBePrefixedWithCount = true;

  public async execCount(position: Position, vimState: VimState): Promise<VimState> {
    let count = this.canBePrefixedWithCount ? vimState.recordedState.count || 1 : 1;
    await vscode.commands.executeCommand(this.commandName, { levels: count});
    vimState.currentMode = ModeName.Normal;
    return vimState;
  }
}

@RegisterAction
class CommandOpenAllFolds extends CommandFold {
  keys = ["z", "R"];
  commandName = "editor.unfoldAll";
}

@RegisterAction
class CommandCloseAllFoldsRecursively extends CommandFold {
  modes = [ModeName.Normal];
  keys = ["z", "C"];
  commandName = "editor.foldRecursively";
}

@RegisterAction
class CommandOpenAllFoldsRecursively extends CommandFold {
  modes = [ModeName.Normal];
  keys = ["z", "O"];
  commandName = "editor.unFoldRecursively";
}

@RegisterAction
class CommandCenterScroll extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["z", "z"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vscode.window.activeTextEditor.revealRange(
      new vscode.Range(vimState.cursorPosition,
                       vimState.cursorPosition),
      vscode.TextEditorRevealType.InCenter);

    return vimState;
  }
}

@RegisterAction
class CommandGoToOtherEndOfHighlightedText extends BaseCommand {
  modes = [ModeName.Visual, ModeName.VisualLine];
  keys = ["o"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    [vimState.cursorStartPosition, vimState.cursorPosition] =
    [vimState.cursorPosition, vimState.cursorStartPosition];

    return vimState;
  }
}

@RegisterAction
class CommandUndo extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["u"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const newPosition = await vimState.historyTracker.goBackHistoryStep();

    if (newPosition !== undefined) {
      vimState.cursorPosition = newPosition;
    }
    vimState.alteredHistory = true;
    return vimState;
  }
}

@RegisterAction
class CommandRedo extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["ctrl+r"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const newPosition = await vimState.historyTracker.goForwardHistoryStep();

    if (newPosition !== undefined) {
      vimState.cursorPosition = newPosition;
    }
    vimState.alteredHistory = true;
    return vimState;
  }
}

@RegisterAction
class CommandMoveFullPageDown extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine, ModeName.VisualBlock];
  keys = ["ctrl+f"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    await vscode.commands.executeCommand("cursorPageDown");
    return vimState;
  }
}

@RegisterAction
class CommandMoveFullPageUp extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine, ModeName.VisualBlock];
  keys = ["ctrl+b"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    await vscode.commands.executeCommand("cursorPageUp");
    return vimState;
  }
}

@RegisterAction
class CommandMoveHalfPageDown extends BaseMovement {
  keys = ["ctrl+d"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return new Position(
      Math.min(TextEditor.getLineCount() - 1, position.line + Configuration.getInstance().scroll),
      position.character
    );
  }
}

@RegisterAction
class CommandMoveHalfPageUp extends BaseMovement {
  keys = ["ctrl+u"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return new Position(Math.max(0, position.line - Configuration.getInstance().scroll), position.character);
  }
}

@RegisterAction
class CommandDeleteToLineEnd extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["D"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    return await new DeleteOperator().run(vimState, position, position.getLineEnd().getLeft());
  }
}

@RegisterAction
class CommandYankFullLine extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["Y"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentRegisterMode = RegisterMode.LineWise;

    return await new YankOperator().run(vimState, position.getLineBegin(), position.getLineEnd().getLeft());
  }
}

@RegisterAction
class CommandChangeToLineEnd extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["C"];
  canBePrefixedWithCount = true;

  public async execCount(position: Position, vimState: VimState): Promise<VimState> {
    let count = this.canBePrefixedWithCount ? vimState.recordedState.count || 1 : 1;
    return new ChangeOperator().run(vimState, position, position.getDownByCount(Math.max(0, count - 1)).getLineEnd().getLeft());
  }
}

@RegisterAction
class CommandClearLine extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["S"];
  canBePrefixedWithCount = true;

  public async execCount(position: Position, vimState: VimState): Promise<VimState> {
    let count = this.canBePrefixedWithCount ? vimState.recordedState.count || 1 : 1;
    let end = position.getDownByCount(Math.max(0, count - 1)).getLineEnd().getLeft();
    return new ChangeOperator().run(vimState, position.getLineBeginRespectingIndent(), end);
  }
}

@RegisterAction
class CommandExitVisualMode extends BaseCommand {
  modes = [ModeName.Visual, ModeName.VisualLine];
  keys = ["v"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.Normal;

    return vimState;
  }
}

@RegisterAction
class CommandVisualMode extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["v"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.Visual;

    return vimState;
  }
}

@RegisterAction
class CommandVisualBlockMode extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["ctrl+v"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.VisualBlock;

    return vimState;
  }
}

@RegisterAction
class CommandVisualLineMode extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual];
  keys = ["V"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.VisualLine;

    return vimState;
  }
}

@RegisterAction
class CommandExitVisualLineMode extends BaseCommand {
  modes = [ModeName.VisualLine];
  keys = ["V"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.Normal;

    return vimState;
  }
}

@RegisterAction
class CommandGoToDefinition extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["g", "d"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const startPosition = Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.start);

    await vscode.commands.executeCommand("editor.action.goToDeclaration");

    // Unfortuantely, the above does not necessarily have to have finished executing
    // (even though we do await!). THe only way to ensure it's done is to poll, which is
    // a major bummer.

    let maxIntervals = 10;

    await new Promise(resolve => {
      let interval = setInterval(() => {
        const positionNow = Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.start);

        if (!startPosition.isEqual(positionNow) || maxIntervals-- < 0) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    vimState.focusChanged = true;
    vimState.cursorPosition = Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.start);

    return vimState;
  }
}

// begin insert commands

@RegisterAction
class CommandInsertAtFirstCharacter extends BaseCommand {
  modes = [ModeName.Normal];
  mustBeFirstKey = true;
  keys = ["I"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.Insert;
    vimState.cursorPosition = position.getFirstLineNonBlankChar();

    return vimState;
  }
}

@RegisterAction
class CommandInsertAtLineBegin extends BaseCommand {
  modes = [ModeName.Normal];
  mustBeFirstKey = true;
  keys = ["g", "I"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.Insert;
    vimState.cursorPosition = position.getLineBegin();

    return vimState;
  }
}

@RegisterAction
class CommandInsertAfterCursor extends BaseCommand {
  modes = [ModeName.Normal];
  mustBeFirstKey = true;
  keys = ["a"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.Insert;
    vimState.cursorPosition = position.getRight();

    return vimState;
  }
}

@RegisterAction
class CommandInsertAtLineEnd extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["A"];
  mustBeFirstKey = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.Insert;
    vimState.cursorPosition = position.getLineEnd();

    return vimState;
  }
}

@RegisterAction
class CommandInsertNewLineAbove extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["O"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    await vscode.commands.executeCommand("editor.action.insertLineBefore");

    vimState.currentMode = ModeName.Insert;
    vimState.cursorPosition = new Position(position.line, TextEditor.getLineAt(position).text.length);
    return vimState;
  }
}

@RegisterAction
class CommandInsertNewLineBefore extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["o"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    await vscode.commands.executeCommand("editor.action.insertLineAfter");

    vimState.currentMode = ModeName.Insert;
    vimState.cursorPosition = new Position(
      position.line + 1,
      TextEditor.getLineAt(new Position(position.line + 1, 0)).text.length);

    return vimState;
  }
}

@RegisterAction
class MoveLeft extends BaseMovement {
  keys = ["h"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getLeft();
  }
}

@RegisterAction
class MoveLeftArrow extends MoveLeft {
  modes = [ModeName.Insert, ModeName.Normal, ModeName.Visual, ModeName.VisualLine, ModeName.VisualBlock];
  keys = ["<left>"];
}

@RegisterAction
class BackSpaceInNormalMode extends BaseMovement {
  modes = [ModeName.Normal];
  keys = ["<backspace>"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getLeftThroughLineBreaks();
  }
}

@RegisterAction
class MoveUp extends BaseMovement {
  keys = ["k"];
  doesntChangeDesiredColumn = true;

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getUp(vimState.desiredColumn);
  }

  public async execActionForOperator(position: Position, vimState: VimState): Promise<Position> {
    vimState.currentRegisterMode = RegisterMode.LineWise;
    return position.getUp(position.getLineEnd().character);
  }
}

@RegisterAction
class MoveUpArrow extends MoveUp {
  modes = [ModeName.Insert, ModeName.Normal, ModeName.Visual, ModeName.VisualLine, ModeName.VisualBlock];
  keys = ["<up>"];
}

@RegisterAction
class MoveDown extends BaseMovement {
  keys = ["j"];
  doesntChangeDesiredColumn = true;

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getDown(vimState.desiredColumn);
  }

  public async execActionForOperator(position: Position, vimState: VimState): Promise<Position> {
    vimState.currentRegisterMode = RegisterMode.LineWise;
    return position.getDown(position.getLineEnd().character);
  }
}

@RegisterAction
class MoveDownArrow extends MoveDown {
  modes = [ModeName.Insert, ModeName.Normal, ModeName.Visual, ModeName.VisualLine, ModeName.VisualBlock];
  keys = ["<down>"];
}

@RegisterAction
class MoveRight extends BaseMovement {
  keys = ["l"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return new Position(position.line, position.character + 1);
  }
}

@RegisterAction
class MoveRightArrow extends MoveRight {
  modes = [ModeName.Insert, ModeName.Normal, ModeName.Visual, ModeName.VisualLine, ModeName.VisualBlock];
  keys = ["<right>"];
}

@RegisterAction
class MoveRightWithSpace extends BaseMovement {
  keys = [" "];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getRightThroughLineBreaks();
  }
}

@RegisterAction
class MoveToRightPane extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = ["ctrl+w", "l"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.focusChanged = true;
    await vscode.commands.executeCommand("workbench.action.focusNextGroup");
    return vimState;
  }
}

@RegisterAction
class MoveToLeftPane  extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = ["ctrl+w", "h"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.focusChanged = true;
    await vscode.commands.executeCommand("workbench.action.focusPreviousGroup");
    return vimState;
  }
}

class BaseTabCommand extends BaseCommand {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  canBePrefixedWithCount = true;
}

@RegisterAction
class CommandTabNext extends BaseTabCommand {
  keys = ["g", "t"];

  public async execCount(position: Position, vimState: VimState): Promise<VimState> {
    (new TabCommand({
      tab: Tab.Next,
      count: vimState.recordedState.count
    })).execute();

    return vimState;
  }
}

@RegisterAction
class CommandTabPrevious extends BaseTabCommand {
  keys = ["g", "T"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    (new TabCommand({
      tab: Tab.Previous,
      count: 1
    })).execute();

    return vimState;
  }
}

@RegisterAction
class MoveDownNonBlank extends BaseMovement {
  keys = ["+"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    return position.getDownByCount(Math.max(count, 1))
             .getFirstLineNonBlankChar();
  }
}

@RegisterAction
class MoveUpNonBlank extends BaseMovement {
  keys = ["-"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    return position.getUpByCount(Math.max(count, 1))
             .getFirstLineNonBlankChar();
  }
}

@RegisterAction
class MoveDownUnderscore extends BaseMovement {
  keys = ["_"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    return position.getDownByCount(Math.max(count - 1, 0))
             .getFirstLineNonBlankChar();
  }
}

@RegisterAction
class MoveToColumn extends BaseMovement {
  keys = ["|"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    return new Position(position.line, Math.max(0, count - 1));
  }
}

@RegisterAction
class MoveFindForward extends BaseMovement {
  keys = ["f", "<character>"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    count = count || 1;
    const toFind = this.keysPressed[1];
    let result = position.findForwards(toFind, count);

    if (!result) {
      return { start: position, stop: position, failed: true };
    }

    if (vimState.recordedState.operator) {
      result = result.getRight();
    }

    return result;
  }
}

@RegisterAction
class MoveFindBackward extends BaseMovement {
  keys = ["F", "<character>"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    count = count || 1;
    const toFind = this.keysPressed[1];
    let result = position.findBackwards(toFind, count);

    if (!result) {
      return { start: position, stop: position, failed: true };
    }

    return result;
  }
}


@RegisterAction
class MoveTilForward extends BaseMovement {
  keys = ["t", "<character>"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    count = count || 1;
    const toFind = this.keysPressed[1];
    let result = position.tilForwards(toFind, count);

    if (!result) {
      return { start: position, stop: position, failed: true };
    }

    if (vimState.recordedState.operator) {
      result = result.getRight();
    }

    return result;
  }
}

@RegisterAction
class MoveTilBackward extends BaseMovement {
  keys = ["T", "<character>"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    count = count || 1;
    const toFind = this.keysPressed[1];
    let result = position.tilBackwards(toFind, count);

    if (!result) {
      return { start: position, stop: position, failed: true };
    }

    return result;
  }
}

@RegisterAction
class MoveLineEnd extends BaseMovement {
  keys = ["$"];
  setsDesiredColumnToEOL = true;

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getLineEnd();
  }
}

@RegisterAction
class MoveLineBegin extends BaseMovement {
  keys = ["0"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getLineBegin();
  }

  public doesActionApply(vimState: VimState, keysPressed: string[]): boolean {
    return super.doesActionApply(vimState, keysPressed) &&
      vimState.recordedState.count === 0;
  }

  public couldActionApply(vimState: VimState, keysPressed: string[]): boolean {
    return super.couldActionApply(vimState, keysPressed) &&
      vimState.recordedState.count === 0;
  }
}

abstract class MoveByScreenLine extends BaseMovement {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  movementType: string;
  /**
   * This parameter is used only when to is lineUp or lineDown.
   * For other screen line movements, we are always operating on the same screen line.
   * So we make its default value as 0.
   */
  noOfLines = 0;

  public async execAction(position: Position, vimState: VimState): Promise<Position | IMovement> {
    await vscode.commands.executeCommand("cursorMove", {
      to: this.movementType,
      select: vimState.currentMode !== ModeName.Normal,
      noOfLines: this.noOfLines
    });

    if (vimState.currentMode === ModeName.Normal) {
      return Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.active);
    } else {
      /**
       * cursorMove command is handling the selection for us.
       * So we are not following our design principal (do no real movement inside an action) here.
       */
      return {
        start: Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.start),
        stop: Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.end)
      };
    }
  }

  public async execActionForOperator(position: Position, vimState: VimState): Promise<IMovement> {
    await vscode.commands.executeCommand("cursorMove", {
      to: this.movementType,
      inSelectionMode: true,
      noOfLines: this.noOfLines
    });

    return {
      start: Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.start),
      stop: Position.FromVSCodePosition(vscode.window.activeTextEditor.selection.end)
    };
  }
}

@RegisterAction
class MoveScreenLineBegin extends MoveByScreenLine {
  keys = ["g", "0"];
  movementType = "wrappedLineStart";
}

@RegisterAction
class MoveScreenNonBlank extends MoveByScreenLine {
  keys = ["g", "^"];
  movementType = "wrappedLineFirstNonWhitespaceCharacter";
}

@RegisterAction
class MoveScreenLineEnd extends MoveByScreenLine {
  keys = ["g", "$"];
  movementType = "wrappedLineEnd";
}

@RegisterAction
class MoveScreenLienEndNonBlank extends MoveByScreenLine {
  keys = ["g", "_"];
  movementType = "wrappedLineLastNonWhitespaceCharacter";
  canBePrefixedWithCount = true;

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    count = count || 1;
    const pos = await this.execAction(position, vimState) as Position;
    return pos.getDownByCount(count - 1);
  }
}

@RegisterAction
class MoveScreenLineCenter extends MoveByScreenLine {
  keys = ["g", "m"];
  movementType = "wrappedLineColumnCenter";
}

@RegisterAction
class MoveUpByScreenLine extends MoveByScreenLine {
  modes = [ModeName.Insert, ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = ["g", "k"];
  movementType = "up";
  noOfLines = 1;
}

@RegisterAction
class MoveDownByScreenLine extends MoveByScreenLine {
  modes = [ModeName.Insert, ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = ["g", "j"];
  movementType = "down";
  noOfLines = 1;
}

@RegisterAction
class MoveToLineFromViewPortTop extends MoveByScreenLine {
  keys = ["H"];
  movementType = "viewPortTop";
  noOfLines = 1;
  canBePrefixedWithCount = true;

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    this.noOfLines = count < 1 ? 1 : count;
    return await this.execAction(position, vimState);
  }
}

@RegisterAction
class MoveToLineFromViewPortBottom extends MoveByScreenLine {
  keys = ["L"];
  movementType = "viewPortBottom";
  noOfLines = 1;
  canBePrefixedWithCount = true;

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    this.noOfLines = count < 1 ? 1 : count;
    return await this.execAction(position, vimState);
  }
}

@RegisterAction
class MoveToViewPortCenter extends MoveScreenLineBegin {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  keys = ["M"];
  movementType = "viewPortCenter";
}

@RegisterAction
class MoveNonBlank extends BaseMovement {
  keys = ["^"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getFirstLineNonBlankChar();
  }
}

@RegisterAction
class MoveNextLineNonBlank extends BaseMovement {
  keys = ["\n"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position> {
    vimState.currentRegisterMode = RegisterMode.LineWise;

    // Count === 0 if just pressing enter in normal mode, need to still go down 1 line
    if (count === 0) {
      count++;
    }

    return position.getDownByCount(count).getFirstLineNonBlankChar();
  }
}

@RegisterAction
class MoveNonBlankFirst extends BaseMovement {
  keys = ["g", "g"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    if (count === 0) {
      return position.getDocumentStart();
    }

    return new Position(count - 1, 0);
  }
}

@RegisterAction
class MoveNonBlankLast extends BaseMovement {
  keys = ["G"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    let stop: Position;

    if (count === 0) {
      stop = new Position(TextEditor.getLineCount() - 1, 0);
    } else {
      stop = new Position(count - 1, 0);
    }

    return {
      start: vimState.cursorStartPosition,
      stop: stop,
      registerMode: RegisterMode.LineWise
    };
  }
}

@RegisterAction
export class MoveWordBegin extends BaseMovement {
  keys = ["w"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    if (vimState.recordedState.operator instanceof ChangeOperator) {

      /*
      From the Vim manual:

      Special case: "cw" and "cW" are treated like "ce" and "cE" if the cursor is
      on a non-blank.  This is because "cw" is interpreted as change-word, and a
      word does not include the following white space.
      */
      return position.getCurrentWordEnd().getRight();
    } else {
      return position.getWordRight();
    }
  }

  public async execActionForOperator(position: Position, vimState: VimState): Promise<Position> {
    const result = await this.execAction(position, vimState);

    /*
    From the Vim documentation:

    Another special case: When using the "w" motion in combination with an
    operator and the last word moved over is at the end of a line, the end of
    that word becomes the end of the operated text, not the first word in the
    next line.
    */

    if (result.line > position.line + 1 || (result.line === position.line + 1 && result.isFirstWordOfLine())) {
      return position.getLineEnd();
    }

    if (result.isLineEnd()) {
        return new Position(result.line, result.character + 1);
    }

    return result;
  }
}

@RegisterAction
class MoveFullWordBegin extends BaseMovement {
  keys = ["W"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    if (vimState.recordedState.operator instanceof ChangeOperator) {
      // TODO use execForOperator? Or maybe dont?

      // See note for w
      return position.getCurrentBigWordEnd().getRight();
    } else {
      return position.getBigWordRight();
    }
  }
}

@RegisterAction
class MoveWordEnd extends BaseMovement {
  keys = ["e"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getCurrentWordEnd();
  }

  public async execActionForOperator(position: Position, vimState: VimState): Promise<Position> {
    let end = position.getCurrentWordEnd();

    return new Position(end.line, end.character + 1);
  }
}

@RegisterAction
class MoveFullWordEnd extends BaseMovement {
  keys = ["E"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getCurrentBigWordEnd();
  }

  public async execActionForOperator(position: Position, vimState: VimState): Promise<Position> {
    return position.getCurrentBigWordEnd().getRight();
  }
}

@RegisterAction
class MoveLastWordEnd  extends BaseMovement {
  keys = ["g", "e"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getLastWordEnd();
  }
}

@RegisterAction
class MoveLastFullWordEnd extends BaseMovement {
  keys = ["g", "E"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getLastBigWordEnd();
  }
}

@RegisterAction
class MoveBeginningWord extends BaseMovement {
  keys = ["b"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getWordLeft();
  }
}

@RegisterAction
class MoveBeginningFullWord extends BaseMovement {
  keys = ["B"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getBigWordLeft();
  }
}

@RegisterAction
class MovePreviousSentenceBegin extends BaseMovement {
  keys = ["("];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getSentenceBegin({forward: false});
  }
}

@RegisterAction
class MoveNextSentenceBegin extends BaseMovement {
  keys = [")"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getSentenceBegin({forward: true});
  }
}

@RegisterAction
class MoveParagraphEnd extends BaseMovement {
  keys = ["}"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getCurrentParagraphEnd();
  }
}

@RegisterAction
class MoveParagraphBegin extends BaseMovement {
  keys = ["{"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getCurrentParagraphBeginning();
  }
}

abstract class MoveSectionBoundary extends BaseMovement {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualLine];
  boundary: string;
  forward: boolean;

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    return position.getSectionBoundary({
      forward: this.forward,
      boundary: this.boundary
    });
  }
}

@RegisterAction
class MoveNextSectionBegin extends MoveSectionBoundary {
  keys = ["]", "]"];
  boundary = "{";
  forward = true;
}

@RegisterAction
class MoveNextSectionEnd extends MoveSectionBoundary {
  keys = ["]", "["];
  boundary = "}";
  forward = true;
}

@RegisterAction
class MovePreviousSectionBegin extends MoveSectionBoundary {
  keys = ["[", "["];
  boundary = "{";
  forward = false;
}

@RegisterAction
class MovePreviousSectionEnd extends MoveSectionBoundary {
  keys = ["[", "]"];
  boundary = "}";
  forward = false;
}

@RegisterAction
class ActionDeleteChar extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["x"];
  canBePrefixedWithCount = true;
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const state = await new DeleteOperator().run(vimState, position, position);

    state.currentMode = ModeName.Normal;

    return state;
  }
}

@RegisterAction
class ActionDeleteCharWithDeleteKey extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["<delete>"];
  canBePrefixedWithCount = true;
  canBeRepeatedWithDot = true;

  public async execCount(position: Position, vimState: VimState): Promise<VimState> {
    // N<del> is a no-op in Vim
    if (vimState.recordedState.count !== 0) {
      return vimState;
    }

    const state = await new DeleteOperator().run(vimState, position, position);

    state.currentMode = ModeName.Normal;

    return state;
  }
}

@RegisterAction
class ActionDeleteLastChar extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["X"];
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    if (position.character === 0) {
      return vimState;
    }

    return await new DeleteOperator().run(vimState, position.getLeft(), position.getLeft());
  }
}

@RegisterAction
class ActionJoin extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["J"];
  canBeRepeatedWithDot = true;
  canBePrefixedWithCount = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    if (position.line === TextEditor.getLineCount() - 1) {
      return vimState; // TODO: bell
    }

    let lineOne = TextEditor.getLineAt(position).text;
    let lineTwo = TextEditor.getLineAt(position.getNextLineBegin()).text;

    lineTwo = lineTwo.substring(position.getNextLineBegin().getFirstLineNonBlankChar().character);

    // TODO(whitespace): need a better way to check for whitespace
    let oneEndsWithWhitespace = lineOne.length > 0 && " \t".indexOf(lineOne[lineOne.length - 1]) > -1;
    let isParenthesisPair = (lineOne[lineOne.length - 1] === '(' && lineTwo[0] === ')');

    const addSpace = !oneEndsWithWhitespace && !isParenthesisPair;

    let resultLine = lineOne + (addSpace ? " " : "") + lineTwo;

    let newState = await new DeleteOperator().run(
      vimState,
      position.getLineBegin(),
      lineTwo.length > 0 ?
        position.getNextLineBegin().getLineEnd().getLeft() :
        position.getLineEnd()
    );

    await TextEditor.insert(resultLine, position);

    newState.cursorPosition = new Position(position.line, lineOne.length + (addSpace ? 1 : 0) + (isParenthesisPair ? 1 : 0) - 1);

    return newState;
  }
}

@RegisterAction
class ActionJoinNoWhitespace extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["g", "J"];
  canBeRepeatedWithDot = true;
  canBePrefixedWithCount = true;

  // gJ is essentially J without the edge cases. ;-)

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    if (position.line === TextEditor.getLineCount() - 1) {
      return vimState; // TODO: bell
    }

    let lineOne = TextEditor.getLineAt(position).text;
    let lineTwo = TextEditor.getLineAt(position.getNextLineBegin()).text;

    lineTwo = lineTwo.substring(position.getNextLineBegin().getFirstLineNonBlankChar().character);

    let resultLine = lineOne + lineTwo;

    let newState = await new DeleteOperator().run(
      vimState,
      position.getLineBegin(),
      lineTwo.length > 0 ?
        position.getNextLineBegin().getLineEnd().getLeft() :
        position.getLineEnd()
    );

    await TextEditor.insert(resultLine, position);

    newState.cursorPosition = new Position(position.line, lineOne.length);

    return newState;
  }
}

@RegisterAction
class ActionReplaceCharacter extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["r", "<character>"];
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const toReplace = this.keysPressed[1];
    const state = await new DeleteOperator().run(vimState, position, position);

    await TextEditor.insertAt(toReplace, position);

    state.cursorPosition = position;

    return state;
  }
}

@RegisterAction
class ActionReplaceCharacterVisualBlock extends BaseCommand {
  modes = [ModeName.VisualBlock];
  keys = ["r", "<character>"];
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const toReplace   = this.keysPressed[1];

    for (const { pos } of Position.IterateBlock(vimState.topLeft, vimState.bottomRight)) {
      vimState = await new DeleteOperator().run(vimState, pos, pos);
      await TextEditor.insertAt(toReplace, pos);
    }

    vimState.cursorPosition = position;
    return vimState;
  }
}

@RegisterAction
class ActionXVisualBlock extends BaseCommand {
  modes = [ModeName.VisualBlock];
  keys = ["x"];
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {

    // Iterate in reverse so we don't lose track of indicies
    for (const { start, end } of Position.IterateLine(vimState, { reverse: true })) {
      vimState = await new DeleteOperator().run(vimState, start, end);
    }

    vimState.cursorPosition = position;
    return vimState;
  }
}

@RegisterAction
class ActionDVisualBlock extends ActionXVisualBlock {
  modes = [ModeName.VisualBlock];
  keys = ["d"];
  canBeRepeatedWithDot = true;
}

@RegisterAction
class ActionGoToInsertVisualBlockMode extends BaseCommand {
  modes = [ModeName.VisualBlock];
  keys = ["I"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    vimState.currentMode = ModeName.VisualBlockInsertMode;
    vimState.recordedState.visualBlockInsertionType = VisualBlockInsertionType.Insert;

    return vimState;
  }
}

@RegisterAction
class ActionChangeInVisualBlockMode extends BaseCommand {
  modes = [ModeName.VisualBlock];
  keys = ["c"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const deleteOperator = new DeleteOperator();

    for (const { start, end } of Position.IterateLine(vimState)) {
      await deleteOperator.delete(start, end, vimState.currentMode, vimState.effectiveRegisterMode(), vimState, true);
    }

    vimState.currentMode = ModeName.VisualBlockInsertMode;
    vimState.recordedState.visualBlockInsertionType = VisualBlockInsertionType.Insert;

    return vimState;
  }
}

// TODO - this is basically a duplicate of the above command

@RegisterAction
class ActionChangeToEOLInVisualBlockMode extends BaseCommand {
  modes = [ModeName.VisualBlock];
  keys = ["C"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const deleteOperator = new DeleteOperator();

    for (const { start } of Position.IterateLine(vimState)) {
      // delete from start up to but not including the newline.
      await deleteOperator.delete(
        start, start.getLineEnd().getLeft(), vimState.currentMode, vimState.effectiveRegisterMode(), vimState, true);
    }

    vimState.currentMode = ModeName.VisualBlockInsertMode;
    vimState.recordedState.visualBlockInsertionType = VisualBlockInsertionType.Insert;

    return vimState;
  }
}

@RegisterAction
class ActionGoToInsertVisualBlockModeAppend extends BaseCommand {
  modes = [ModeName.VisualBlock];
  keys = ["A"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    if (vimState.cursorPosition.character >= vimState.cursorStartPosition.character) {
      vimState.cursorPosition = vimState.cursorPosition.getRight();
    } else {
      vimState.cursorStartPosition = vimState.cursorStartPosition.getRight();
    }

    vimState.currentMode = ModeName.VisualBlockInsertMode;
    vimState.recordedState.visualBlockInsertionType = VisualBlockInsertionType.Append;

    return vimState;
  }
}

@RegisterAction
export class YankVisualBlockMode extends BaseOperator {
    public keys = ["y"];
    public modes = [ModeName.VisualBlock];
    canBeRepeatedWithDot = false;

    public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
      let toCopy: string[] = [];

      for ( const { line } of Position.IterateLine(vimState)) {
        toCopy.push(line);
      }

      Register.put(toCopy, vimState);

      vimState.currentMode = ModeName.Normal;
      vimState.cursorPosition = start;
      return vimState;
    }
}


@RegisterAction
class InsertInInsertVisualBlockMode extends BaseCommand {
  modes = [ModeName.VisualBlockInsertMode];
  keys = ["<any>"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    let char = this.keysPressed[0];
    let posChange = 0;
    let insertAtStart = vimState.recordedState.visualBlockInsertionType === VisualBlockInsertionType.Insert;

    if (char === '\n') {
      return vimState;
    }

    if (char === '<backspace>' && vimState.topLeft.character === 0) {
      return vimState;
    }

    for (const { start, end } of Position.IterateLine(vimState)) {
      const insertPos = insertAtStart ? start : end;

      if (char === '<backspace>') {
        await TextEditor.backspace(insertPos.getLeft());

        posChange = -1;
      } else {
        await TextEditor.insert(this.keysPressed[0], insertPos.getLeft());

        posChange = 1;
      }
    }

    vimState.cursorStartPosition = vimState.cursorStartPosition.getRight(posChange);
    vimState.cursorPosition      = vimState.cursorPosition.getRight(posChange);

    return vimState;
  }
}

// DOUBLE MOTIONS
// (dd yy cc << >>)
// These work because there is a check in does/couldActionApply where
// you can't run an operator if you already have one going (which is logical).
// However there is the slightly weird behavior where dy actually deletes the whole
// line, lol.
@RegisterAction
class MoveDD extends BaseMovement {
  modes = [ModeName.Normal];
  keys = ["d"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position | IMovement> {
    return {
      start        : position.getLineBegin(),
      stop         : position.getDownByCount(Math.max(0, count - 1)).getLineEnd(),
      registerMode : RegisterMode.LineWise
    };
  }
}

@RegisterAction
class MoveYY extends BaseMovement {
  modes = [ModeName.Normal];
  keys = ["y"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<IMovement> {
    return {
      start       : position.getLineBegin(),
      stop        : position.getDownByCount(Math.max(0, count - 1)).getLineEnd(),
      registerMode: RegisterMode.LineWise,
    };
  }
}

@RegisterAction
class MoveCC extends BaseMovement {
  modes = [ModeName.Normal];
  keys = ["c"];

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<IMovement> {
    return {
      start       : position.getLineBeginRespectingIndent(),
      stop        : position.getDownByCount(Math.max(0, count - 1)).getLineEnd(),
      registerMode: RegisterMode.CharacterWise
    };
  }
}

@RegisterAction
class MoveIndent extends BaseMovement {
  modes = [ModeName.Normal];
  keys = [">"];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    return {
      start       : position.getLineBegin(),
      stop        : position.getLineEnd(),
    };
  }
}

@RegisterAction
class MoveOutdent extends BaseMovement {
  modes = [ModeName.Normal];
  keys = ["<"];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    return {
      start       : position.getLineBegin(),
      stop        : position.getLineEnd(),
    };
  }
}

@RegisterAction
class ActionDeleteLineVisualMode extends BaseCommand {
  modes = [ModeName.Visual, ModeName.VisualLine];
  keys = ["X"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    return await new DeleteOperator().run(vimState, position.getLineBegin(), position.getLineEnd());
  }
}

@RegisterAction
class ActionChangeChar extends BaseCommand {
  modes = [ModeName.Normal];
  keys = ["s"];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    const state = await new ChangeOperator().run(vimState, position, position);

    state.currentMode = ModeName.Insert;

    return state;
  }
}

abstract class TextObjectMovement extends BaseMovement {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualBlock];
  canBePrefixedWithCount = true;

  public async execActionForOperator(position: Position, vimState: VimState): Promise<IMovement> {
    const res = await this.execAction(position, vimState) as IMovement;
    // Since we need to handle leading spaces, we cannot use MoveWordBegin.execActionForOperator
    // In normal mode, the character on the stop position will be the first character after the operator executed
    // and we do left-shifting in operator-pre-execution phase, here we need to right-shift the stop position accordingly.
    res.stop = new Position(res.stop.line, res.stop.character + 1);

    return res;
  }
}

@RegisterAction
class SelectWord extends TextObjectMovement {
  keys = ["a", "w"];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;

    const currentChar = TextEditor.getLineAt(position).text[position.character];

    if (/\s/.test(currentChar)) {
        start = position.getLastWordEnd().getRight();
        stop = position.getCurrentWordEnd();
    } else {
        stop = position.getWordRight().getLeftThroughLineBreaks();

        if (stop.isEqual(position.getCurrentWordEnd())) {
          start = position.getLastWordEnd().getRight();
        } else {
          start = position.getWordLeft(true);
        }
    }

    if (vimState.currentMode === ModeName.Visual && !vimState.cursorPosition.isEqual(vimState.cursorStartPosition)) {
        start = vimState.cursorStartPosition;

        if (vimState.cursorPosition.isBefore(vimState.cursorStartPosition)) {
          // If current cursor postion is before cursor start position, we are selecting words in reverser order.
          if (/\s/.test(currentChar)) {
            stop = position.getWordLeft(true);
          } else {
            stop = position.getLastWordEnd().getRight();
          }
        }
    }

    return {
      start: start,
      stop: stop
    };
  }
}

@RegisterAction
class SelectABigWord extends TextObjectMovement {
  keys = ["a", "W"];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;

    const currentChar = TextEditor.getLineAt(position).text[position.character];

    if (/\s/.test(currentChar)) {
        start = position.getLastBigWordEnd().getRight();
        stop = position.getCurrentBigWordEnd();
    } else {
        start = position.getBigWordLeft();
        stop = position.getBigWordRight().getLeft();
    }

    if (vimState.currentMode === ModeName.Visual && !vimState.cursorPosition.isEqual(vimState.cursorStartPosition)) {
        start = vimState.cursorStartPosition;

        if (vimState.cursorPosition.isBefore(vimState.cursorStartPosition)) {
          // If current cursor postion is before cursor start position, we are selecting words in reverser order.
          if (/\s/.test(currentChar)) {
            stop = position.getBigWordLeft();
          } else {
            stop = position.getLastBigWordEnd().getRight();
          }
        }
    }

    return {
      start: start,
      stop: stop
    };
  }
}

@RegisterAction
class SelectInnerWord extends TextObjectMovement {
  modes = [ModeName.Normal, ModeName.Visual];
  keys = ["i", "w"];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;
    const currentChar = TextEditor.getLineAt(position).text[position.character];

    if (/\s/.test(currentChar)) {
        start = position.getLastWordEnd().getRight();
        stop = position.getWordRight().getLeft();
    } else {
        start = position.getWordLeft(true);
        stop = position.getCurrentWordEnd(true);
    }

    if (vimState.currentMode === ModeName.Visual && !vimState.cursorPosition.isEqual(vimState.cursorStartPosition)) {
      start = vimState.cursorStartPosition;

      if (vimState.cursorPosition.isBefore(vimState.cursorStartPosition)) {
        // If current cursor postion is before cursor start position, we are selecting words in reverser order.
        if (/\s/.test(currentChar)) {
          stop = position.getLastWordEnd().getRight();
        } else {
          stop = position.getWordLeft(true);
        }
      }
    }

    return {
      start: start,
      stop: stop
    };
  }
}

@RegisterAction
class SelectInnerBigWord extends TextObjectMovement {
  modes = [ModeName.Normal, ModeName.Visual];
  keys = ["i", "W"];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;
    const currentChar = TextEditor.getLineAt(position).text[position.character];

    if (/\s/.test(currentChar)) {
        start = position.getLastBigWordEnd().getRight();
        stop = position.getBigWordRight().getLeft();
    } else {
        start = position.getBigWordLeft();
        stop = position.getCurrentBigWordEnd(true);
    }

    if (vimState.currentMode === ModeName.Visual && !vimState.cursorPosition.isEqual(vimState.cursorStartPosition)) {
      start = vimState.cursorStartPosition;

      if (vimState.cursorPosition.isBefore(vimState.cursorStartPosition)) {
        // If current cursor postion is before cursor start position, we are selecting words in reverser order.
        if (/\s/.test(currentChar)) {
          stop = position.getLastBigWordEnd().getRight();
        } else {
          stop = position.getBigWordLeft();
        }
      }
    }

    return {
      start: start,
      stop: stop
    };
  }
}

@RegisterAction
class SelectSentence extends TextObjectMovement {
  keys = ["a", "s"];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;

    const currentSentenceBegin = position.getSentenceBegin({forward: false});
    const currentSentenceNonWhitespaceEnd = currentSentenceBegin.getCurrentSentenceEnd();

    if (currentSentenceNonWhitespaceEnd.isBefore(position)) {
      // The cursor is on a trailing white space.
      start = currentSentenceNonWhitespaceEnd.getRight();
      stop = currentSentenceBegin.getSentenceBegin({forward: true}).getCurrentSentenceEnd();
    } else {
      const nextSentenceBegin = currentSentenceBegin.getSentenceBegin({forward: true});

      // If the sentence has no trailing white spaces, `as` should include its leading white spaces.
      if (nextSentenceBegin.isEqual(currentSentenceBegin.getCurrentSentenceEnd())) {
        start = currentSentenceBegin.getSentenceBegin({forward: false}).getCurrentSentenceEnd().getRight();
        stop = nextSentenceBegin;
      } else {
        start = currentSentenceBegin;
        stop = nextSentenceBegin.getLeft();
      }
    }

    if (vimState.currentMode === ModeName.Visual && !vimState.cursorPosition.isEqual(vimState.cursorStartPosition)) {
      start = vimState.cursorStartPosition;

      if (vimState.cursorPosition.isBefore(vimState.cursorStartPosition)) {
        // If current cursor postion is before cursor start position, we are selecting sentences in reverser order.
        if (currentSentenceNonWhitespaceEnd.isAfter(vimState.cursorPosition)) {
          stop = currentSentenceBegin.getSentenceBegin({forward: false}).getCurrentSentenceEnd().getRight();
        } else {
          stop = currentSentenceBegin;
        }
      }
    }

    return {
      start: start,
      stop: stop
    };
  }
}

@RegisterAction
class SelectInnerSentence extends TextObjectMovement {
  keys = ["i", "s"];

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    let start: Position;
    let stop: Position;

    const currentSentenceBegin = position.getSentenceBegin({forward: false});
    const currentSentenceNonWhitespaceEnd = currentSentenceBegin.getCurrentSentenceEnd();

    if (currentSentenceNonWhitespaceEnd.isBefore(position)) {
      // The cursor is on a trailing white space.
      start = currentSentenceNonWhitespaceEnd.getRight();
      stop = currentSentenceBegin.getSentenceBegin({forward: true}).getLeft();
    } else {
      start = currentSentenceBegin;
      stop = currentSentenceNonWhitespaceEnd;
    }

    if (vimState.currentMode === ModeName.Visual && !vimState.cursorPosition.isEqual(vimState.cursorStartPosition)) {
      start = vimState.cursorStartPosition;

      if (vimState.cursorPosition.isBefore(vimState.cursorStartPosition)) {
        // If current cursor postion is before cursor start position, we are selecting sentences in reverser order.
        if (currentSentenceNonWhitespaceEnd.isAfter(vimState.cursorPosition)) {
          stop = currentSentenceBegin;
        } else {
          stop = currentSentenceNonWhitespaceEnd.getRight();
        }
      }
    }

    return {
      start: start,
      stop: stop
    };
  }
}
@RegisterAction
class MoveToMatchingBracket extends BaseMovement {
  keys = ["%"];

  public async execAction(position: Position, vimState: VimState): Promise<Position | IMovement> {
    const text = TextEditor.getLineAt(position).text;
    const charToMatch = text[position.character];
    const toFind = PairMatcher.pairings[charToMatch];
    const failure = { start: position, stop: position, failed: true };

    if (!toFind || !toFind.matchesWithPercentageMotion) {
      // If we're not on a match, go right until we find a
      // pairable character or hit the end of line.

      for (let i = position.character; i < text.length; i++) {
        if (PairMatcher.pairings[text[i]]) {
          // We found an opening char, now move to the matching closing char
          const openPosition = new Position(position.line, i);
          const result = PairMatcher.nextPairedChar(openPosition, text[i], true);

          if (!result) { return failure; }
          return result;
        }
      }

      return failure;
    }

    const result = PairMatcher.nextPairedChar(position, charToMatch, true);
    if (!result) { return failure; }
    return result;
  }

  public async execActionForOperator(position: Position, vimState: VimState): Promise<Position | IMovement> {
    const result = await this.execAction(position, vimState);

    if (isIMovement(result)) {
      if (result.failed) {
        return result;
      } else {
        throw new Error("Did not ever handle this case!");
      }
    }

    if (position.compareTo(result) > 0) {
      return result.getLeft();
    } else {
      return result.getRight();
    }
  }
}

abstract class MoveInsideCharacter extends BaseMovement {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualBlock];
  protected charToMatch: string;
  protected includeSurrounding = false;

  public async execAction(position: Position, vimState: VimState): Promise<Position | IMovement> {
    const failure = { start: position, stop: position, failed: true };
    const text = TextEditor.getLineAt(position).text;
    const closingChar = PairMatcher.pairings[this.charToMatch].match;
    const closedMatch = text[position.character] === closingChar;

    // First, search backwards for the opening character of the sequence
    let startPos = PairMatcher.nextPairedChar(position, closingChar, closedMatch);
    if (startPos === undefined) { return failure; }

    const startPlusOne = new Position(startPos.line, startPos.character + 1);

    let endPos = PairMatcher.nextPairedChar(startPlusOne, this.charToMatch, false);
    if (endPos === undefined) { return failure; }

    if (this.includeSurrounding) {
      endPos = new Position(endPos.line, endPos.character + 1);
    } else {
      startPos = startPlusOne;
    }

    // If the closing character is the first on the line, don't swallow it.
    if (endPos.character === 0) {
      endPos = endPos.getLeftThroughLineBreaks();
    }

    return {
      start : startPos,
      stop  : endPos,
    };
  }
}

@RegisterAction
class MoveIParentheses extends MoveInsideCharacter {
  keys = ["i", "("];
  charToMatch = "(";
}

@RegisterAction
class MoveIClosingParentheses extends MoveInsideCharacter {
  keys = ["i", ")"];
  charToMatch = "(";
}

@RegisterAction
class MoveIClosingParenthesesBlock extends MoveInsideCharacter {
  keys = ["i", "b"];
  charToMatch = "(";
}

@RegisterAction
class MoveAParentheses extends MoveInsideCharacter {
  keys = ["a", "("];
  charToMatch = "(";
  includeSurrounding = true;
}

@RegisterAction
class MoveAClosingParentheses extends MoveInsideCharacter {
  keys = ["a", ")"];
  charToMatch = "(";
  includeSurrounding = true;
}

@RegisterAction
class MoveAParenthesesBlock extends MoveInsideCharacter {
  keys = ["a", "b"];
  charToMatch = "(";
  includeSurrounding = true;
}

@RegisterAction
class MoveICurlyBrace extends MoveInsideCharacter {
  keys = ["i", "{"];
  charToMatch = "{";
}

@RegisterAction
class MoveIClosingCurlyBrace extends MoveInsideCharacter {
  keys = ["i", "}"];
  charToMatch = "{";
}

@RegisterAction
class MoveIClosingCurlyBraceBlock extends MoveInsideCharacter {
  keys = ["i", "B"];
  charToMatch = "{";
}

@RegisterAction
class MoveACurlyBrace extends MoveInsideCharacter {
  keys = ["a", "{"];
  charToMatch = "{";
  includeSurrounding = true;
}

@RegisterAction
class MoveAClosingCurlyBrace extends MoveInsideCharacter {
  keys = ["a", "}"];
  charToMatch = "{";
  includeSurrounding = true;
}

@RegisterAction
class MoveAClosingCurlyBraceBlock extends MoveInsideCharacter {
  keys = ["a", "B"];
  charToMatch = "{";
  includeSurrounding = true;
}

@RegisterAction
class MoveICaret extends MoveInsideCharacter {
  keys = ["i", "<"];
  charToMatch = "<";
}

@RegisterAction
class MoveIClosingCaret extends MoveInsideCharacter {
  keys = ["i", ">"];
  charToMatch = "<";
}

@RegisterAction
class MoveACaret extends MoveInsideCharacter {
  keys = ["a", "<"];
  charToMatch = "<";
  includeSurrounding = true;
}

@RegisterAction
class MoveAClosingCaret extends MoveInsideCharacter {
  keys = ["a", ">"];
  charToMatch = "<";
  includeSurrounding = true;
}

@RegisterAction
class MoveISquareBracket extends MoveInsideCharacter {
  keys = ["i", "["];
  charToMatch = "[";
}

@RegisterAction
class MoveIClosingSquareBraket extends MoveInsideCharacter {
  keys = ["i", "]"];
  charToMatch = "[";
}

@RegisterAction
class MoveASquareBracket extends MoveInsideCharacter {
  keys = ["a", "["];
  charToMatch = "[";
  includeSurrounding = true;
}

@RegisterAction
class MoveAClosingSquareBracket extends MoveInsideCharacter {
  keys = ["a", "]"];
  charToMatch = "[";
  includeSurrounding = true;
}

abstract class MoveQuoteMatch extends BaseMovement {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualBlock];
  protected charToMatch: string;
  protected includeSurrounding = false;

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    const text = TextEditor.getLineAt(position).text;
    const quoteMatcher = new QuoteMatcher(this.charToMatch, text);
    const start = quoteMatcher.findOpening(position.character);
    const end = quoteMatcher.findClosing(start + 1);

    if (start === -1 || end === -1 || end === start || end < position.character) {
      return {
        start: position,
        stop: position,
        failed: true
      };
    }

    let startPos = new Position(position.line, start);
    let endPos = new Position(position.line, end);
    if (!this.includeSurrounding) {
      startPos = startPos.getRight();
      endPos = endPos.getLeft();
    }

    return {
      start: startPos,
      stop: endPos
    };
  }

  public async execActionForOperator(position: Position, vimState: VimState): Promise<IMovement> {
    const res = await this.execAction(position, vimState);

    res.stop = res.stop.getRight();

    return res;
  }
}

@RegisterAction
class MoveInsideSingleQuotes extends MoveQuoteMatch {
  keys = ["i", "'"];
  charToMatch = "'";
  includeSurrounding = false;
}

@RegisterAction
class MoveASingleQuotes extends MoveQuoteMatch {
  keys = ["a", "'"];
  charToMatch = "'";
  includeSurrounding = true;
}

@RegisterAction
class MoveInsideDoubleQuotes extends MoveQuoteMatch {
  keys = ["i", "\""];
  charToMatch = "\"";
  includeSurrounding = false;
}

@RegisterAction
class MoveADoubleQuotes extends MoveQuoteMatch {
  keys = ["a", "\""];
  charToMatch = "\"";
  includeSurrounding = true;
}

@RegisterAction
class MoveInsideBacktick extends MoveQuoteMatch {
  keys = ["i", "`"];
  charToMatch = "`";
  includeSurrounding = false;
}

@RegisterAction
class MoveABacktick extends MoveQuoteMatch {
  keys = ["a", "`"];
  charToMatch = "`";
  includeSurrounding = true;
}

@RegisterAction
class MoveToUnclosedRoundBracketBackward extends MoveToMatchingBracket {
  keys = ["[", "("];

  public async execAction(position: Position, vimState: VimState): Promise<Position | IMovement> {
    const failure = { start: position, stop: position, failed: true };
    const charToMatch = ")";
    const result = PairMatcher.nextPairedChar(position.getLeftThroughLineBreaks(), charToMatch, false);

    if (!result) { return failure; }
    return result;
  }
}

@RegisterAction
class MoveToUnclosedRoundBracketForward extends MoveToMatchingBracket {
  keys = ["]", ")"];

  public async execAction(position: Position, vimState: VimState): Promise<Position | IMovement> {
    const failure = { start: position, stop: position, failed: true };
    const charToMatch = "(";
    const result = PairMatcher.nextPairedChar(position.getRightThroughLineBreaks(), charToMatch, false);

    if (!result) { return failure; }
    return result;
  }
}

@RegisterAction
class MoveToUnclosedCurlyBracketBackward extends MoveToMatchingBracket {
  keys = ["[", "{"];

  public async execAction(position: Position, vimState: VimState): Promise<Position | IMovement> {
    const failure = { start: position, stop: position, failed: true };
    const charToMatch = "}";
    const result = PairMatcher.nextPairedChar(position.getLeftThroughLineBreaks(), charToMatch, false);

    if (!result) { return failure; }
    return result;
  }
}

@RegisterAction
class MoveToUnclosedCurlyBracketForward extends MoveToMatchingBracket {
  keys = ["]", "}"];

  public async execAction(position: Position, vimState: VimState): Promise<Position | IMovement> {
    const failure = { start: position, stop: position, failed: true };
    const charToMatch = "{";
    const result = PairMatcher.nextPairedChar(position.getRightThroughLineBreaks(), charToMatch, false);

    if (!result) { return failure; }
    return result;
  }
}

@RegisterAction
class ToggleCaseOperator extends BaseOperator {
  public keys = ["~"];
  public modes = [ModeName.Visual, ModeName.VisualLine];

  public async run(vimState: VimState, start: Position, end: Position): Promise<VimState> {
    const range = new vscode.Range(start, new Position(end.line, end.character + 1));
    const char = TextEditor.getText(range);

    // Try lower-case
    let toggled = char.toLocaleLowerCase();
    if (toggled === char) {
      // Try upper-case
      toggled = char.toLocaleUpperCase();
    }

    if (toggled !== char) {
      await TextEditor.replace(range, toggled);
    }

    const cursorPosition = start.isBefore(end) ? start : end;
    vimState.cursorPosition = cursorPosition;
    vimState.cursorStartPosition = cursorPosition;
    vimState.currentMode = ModeName.Normal;

    return vimState;
  }
}

@RegisterAction
class ToggleCaseWithMotion extends ToggleCaseOperator {
  public keys = ["g", "~"];
  public modes = [ModeName.Normal];
}

@RegisterAction
class ToggleCaseAndMoveForward extends BaseMovement {
  modes = [ModeName.Normal];
  keys = ["~"];

  public async execAction(position: Position, vimState: VimState): Promise<Position> {
    await new ToggleCaseOperator().run(vimState, position, position);

    return position.getRight();
  }
}

abstract class IncrementDecrementNumberAction extends BaseMovement {
  modes = [ModeName.Normal];
  canBePrefixedWithCount = true;

  offset: number;

  public async execActionWithCount(position: Position, vimState: VimState, count: number): Promise<Position> {
    count = count || 1;
    const text = TextEditor.getLineAt(position).text;

    for (let { start, end, word } of Position.IterateWords(position.getWordLeft(true))) {
      // '-' doesn't count as a word, but is important to include in parsing the number
      if (text[start.character - 1] === '-') {
        start = start.getLeft();
        word = text[start.character] + word;
      }
      // Strict number parsing so "1a" doesn't silently get converted to "1"
      const num = NumericString.parse(word);

      if (num !== null) {
        return this.replaceNum(num, this.offset * count, start, end);
      }
    }
    // No usable numbers, return the original position
    return position;
  }

  public async replaceNum(start: NumericString, offset: number, startPos: Position, endPos: Position): Promise<Position> {
    const oldWidth = start.toString().length;
    start.value += offset;
    const newNum = start.toString();

    const range = new vscode.Range(startPos, endPos.getRight());

    if (oldWidth === newNum.length) {
      await TextEditor.replace(range, newNum);
    } else {
      // Can't use replace, since new number is a different width than old
      await TextEditor.delete(range);
      await TextEditor.insertAt(newNum, startPos);
      // Adjust end position according to difference in width of number-string
      endPos = new Position(endPos.line, endPos.character + (newNum.length - oldWidth));
    }

    return endPos;
  }
}

@RegisterAction
class IncrementNumberAction extends IncrementDecrementNumberAction {
  keys = ["ctrl+a"];
  offset = +1;
}

@RegisterAction
class DecrementNumberAction extends IncrementDecrementNumberAction {
  keys = ["ctrl+x"];
  offset = -1;
}

abstract class MoveTagMatch extends BaseMovement {
  modes = [ModeName.Normal, ModeName.Visual, ModeName.VisualBlock];
  protected includeTag = false;

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    const text = TextEditor.getLineAt(position).text;
    const tagMatcher = new TagMatcher(text, position.character);
    const start = tagMatcher.findOpening(this.includeTag);
    const end = tagMatcher.findClosing(this.includeTag);

    if (start === undefined || end === undefined || end === start) {
      return {
        start: position,
        stop: position,
        failed: true
      };
    }

    let startPos = new Position(position.line, start);
    let endPos = new Position(position.line, end - 1);

    return {
      start: startPos,
      stop: endPos
    };
  }

  public async execActionForOperator(position: Position, vimState: VimState): Promise<IMovement> {
    const res = await this.execAction(position, vimState);

    res.stop = res.stop.getRight();

    return res;
  }
}

@RegisterAction
class MoveInsideTag extends MoveTagMatch {
  keys = ["i", "t"];
  includeTag = false;
}

@RegisterAction
class MoveAroundTag extends MoveTagMatch {
  keys = ["a", "t"];
  includeTag = true;
}
