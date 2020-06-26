import { IConfiguration } from './configuration/iconfiguration';
import { ModeHandler } from './mode/modeHandler';

/**
 * Global variables shared throughout extension
 */
export class Globals {
  /**
   * This is where we put files like HistoryFile. The path is given to us by VSCode.
   */
  static extensionStoragePath: string = 'vscode-vim';

  /**
   * Used for testing.
   */
  static isTesting = false;
  static mockModeHandler: ModeHandler;
  static mockConfiguration: IConfiguration;
}
