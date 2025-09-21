import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as ExtensionUtils from "resource:///org/gnome/shell/misc/extensionUtils.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const IDENTIFIER_UUID = "130cbc66-235c-4bd6-8571-98d2d8bba5e2";

export class DesktopIconsUsableAreaClass {
  _checkIfExtensionIsEnabled(extension) {
    return (
      extension?.state === ExtensionUtils.ExtensionState.ENABLED ||
      extension?.state === ExtensionUtils.ExtensionState.ACTIVE
    );
  }

  constructor() {
    const Me = Extension.lookupByURL(import.meta.url);
    this._UUID = Me.uuid;
    this._extensionManager = Main.extensionManager;
    this._timedMarginsID = 0;
    this._margins = {};
    this._emID = this._extensionManager.connect(
      "extension-state-changed",
      (_obj, extension) => {
        if (!extension) return;

        // If an extension is being enabled and lacks the DesktopIconsUsableArea object, we can avoid launching a refresh
        if (this._checkIfExtensionIsEnabled(extension)) {
          this._sendMarginsToExtension(extension);
          return;
        }
        // if the extension is being disabled, we must do a full refresh, because if there were other extensions originally
        // loaded after that extension, those extensions will be disabled and enabled again without notification
        this._changedMargins();
      }
    );
  }

  /**
   * Sets or updates the top, bottom, left and right margins for a
   * monitor. Values are measured from the monitor border (and NOT from
   * the workspace border).
   *
   * @param {int} monitor Monitor number to which set the margins.
   *                      A negative value means "the primary monitor".
   * @param {int} top Top margin in pixels
   * @param {int} bottom Bottom margin in pixels
   * @param {int} left Left margin in pixels
   * @param {int} right Right margin in pixels
   */
  setMargins(monitor, top, bottom, left, right) {
    this._margins[monitor] = {
      top: top,
      bottom: bottom,
      left: left,
      right: right,
    };
    this._changedMargins();
  }

  /**
   * Clears the current margins. Must be called before configuring the monitors
   * margins with setMargins().
   */
  resetMargins() {
    this._margins = {};
    this._changedMargins();
  }

  /**
   * Disconnects all the signals and removes the margins.
   */
  destroy() {
    if (this._emID) {
      this._extensionManager.disconnect(this._emID);
      this._emID = 0;
    }
    if (this._timedMarginsID) {
      GLib.source_remove(this._timedMarginsID);
      this._timedMarginsID = 0;
    }
    this._margins = null;
    this._changedMargins();
  }

  _changedMargins() {
    if (this._timedMarginsID) {
      GLib.source_remove(this._timedMarginsID);
    }
    this._timedMarginsID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      this._sendMarginsToAll();
      this._timedMarginsID = 0;
      return GLib.SOURCE_REMOVE;
    });
  }

  _sendMarginsToAll() {
    this._extensionManager
      .getUuids()
      .forEach((uuid) =>
        this._sendMarginsToExtension(this._extensionManager.lookup(uuid))
      );
  }

  _sendMarginsToExtension(extension) {
    // check that the extension is an extension that has the logic to accept
    // working margins
    if (!this._checkIfExtensionIsEnabled(extension)) return;

    const usableArea = extension?.stateObj?.DesktopIconsUsableArea;
    if (usableArea?.uuid === IDENTIFIER_UUID)
      usableArea.setMarginsForExtension(this._UUID, this._margins);
  }
}
