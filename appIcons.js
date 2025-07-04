/*
 * Dash-To-Panel extension for Gnome 48
 */
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Graphene from "gi://Graphene";
import GObject from "gi://GObject";
import Mtk from "gi://Mtk";
import Shell from "gi://Shell";
import St from "gi://St";
import * as AppDisplay from "resource:///org/gnome/shell/ui/appDisplay.js";
import * as AppMenu from "resource:///org/gnome/shell/ui/appMenu.js";
import * as Dash from "resource:///org/gnome/shell/ui/dash.js";
import * as DND from "resource:///org/gnome/shell/ui/dnd.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Util from "resource:///org/gnome/shell/misc/util.js";
import * as BoxPointer from "resource:///org/gnome/shell/ui/boxpointer.js";
import { EventEmitter } from "resource:///org/gnome/shell/misc/signals.js";
import * as Utils from "./utils.js";
import * as Taskbar from "./taskbar.js";
import {
  SETTINGS,
  DESKTOPSETTINGS,
  TERMINALSETTINGS,
  EXTENSION_PATH,
  tracker,
} from "./extension.js";
import {
  gettext as _,
  ngettext,
} from "resource:///org/gnome/shell/extensions/extension.js";

//timeout names
const T2 = "mouseScrollTimeout";
const T3 = "showDotsTimeout";
const T4 = "overviewWindowDragEndTimeout";
const T5 = "switchWorkspaceTimeout";
const T6 = "displayProperIndicatorTimeout";

const TITLE_RIGHT_PADDING = 2;
const DOUBLE_CLICK_DELAY_MS = 450;
let MAX_INDICATORS = 1;
export const DEFAULT_PADDING_SIZE = 2;

let DOT_POSITION = {
  BOTTOM: "BOTTOM",
};

let recentlyClickedAppLoopId = 0;
let recentlyClickedApp = null;
let recentlyClickedAppWindows = null;
let recentlyClickedAppIndex = 0;
let recentlyClickedAppMonitorIndex;

/**
 * Extend AppIcon
 *
 * - Apply a css class based on the number of windows of each application (#N);
 * - Draw a dot for each window of the application based on the default "dot" style which is hidden (#N);
 *   a class of the form "running#N" is applied to the AppWellIcon actor.
 *   like the original .running one.
 * - add a .focused style to the focused app
 * - Customize click actions.
 * - Update minimization animation target
 *
 */

export const TaskbarAppIcon = GObject.registerClass(
  {},
  class TaskbarAppIcon extends AppDisplay.AppIcon {
    _init(appInfo, panel, iconParams, previewMenu, iconAnimator) {
      this.dtpPanel = panel;
      this._nWindows = 0;
      this.window = appInfo.window;
      this.isLauncher = appInfo.isLauncher;
      this._previewMenu = previewMenu;
      this.iconAnimator = iconAnimator;
      this.lastClick = 0;
      this._appicon_normalstyle = "";
      this._appicon_hoverstyle = "";
      this._appicon_pressedstyle = "";

      super._init(appInfo.app, iconParams);

      this._signalsHandler = new Utils.GlobalSignalsHandler();
      this._timeoutsHandler = new Utils.TimeoutsHandler();

      // Fix touchscreen issues before the listener is added by the parent constructor.
      this._onTouchEvent = function (actor, event) {
        if (event.type() == Clutter.EventType.TOUCH_BEGIN) {
          // Open the popup menu on long press.
          this._setPopupTimeout();
        } else if (
          this._menuTimeoutId != 0 &&
          (event.type() == Clutter.EventType.TOUCH_END ||
            event.type() == Clutter.EventType.TOUCH_CANCEL)
        ) {
          // Activate/launch the application.
          this.activate(1);
          this._removeMenuTimeout();
        }
        // Disable dragging via touch screen as it's buggy as hell. Not perfect for tablet users, but the alternative is way worse.
        // Also, EVENT_PROPAGATE launches applications twice with this solution, so this.activate(1) above must only be called if there's already a window.
        return Clutter.EVENT_STOP;
      };
      // Hack for missing TOUCH_END event.
      this._onLeaveEvent = function () {
        this.fake_release();
        if (this._menuTimeoutId != 0) this.activate(1); // Activate/launch the application if TOUCH_END didn't fire.
        this._removeMenuTimeout();
      };

      this._dot.set_width(0);
      this._isGroupApps = SETTINGS.get_boolean("group-apps");

      this._container = new St.Widget({
        style_class: "dtp-container",
        layout_manager: new Clutter.BinLayout(),
      });
      this._dotsContainer = new St.Widget({
        style_class: "dtp-dots-container",
        layout_manager: new Clutter.BinLayout(),
      });
      this._dtpIconContainer = new St.Widget({
        style_class: "dtp-icon",
        layout_manager: new Clutter.BinLayout(),
        style: getIconContainerStyle(),
      });
      this._dtpIconContainer.set_pivot_point(0.5, 0.5);
      this._iconContainer.set_pivot_point(0.5, 0.5);
      this.remove_child(this._iconContainer);
      this.icon._iconBin.set_pivot_point(0.5, 0.5);
      this._dtpIconContainer.add_child(this._iconContainer);
      if (appInfo.window) {
        let box = Utils.createBoxLayout();
        this._windowTitle = new St.Label({
          y_align: Clutter.ActorAlign.CENTER,
          x_align: Clutter.ActorAlign.START,
          style_class: "overview-label",
        });
        this._updateWindowTitle();
        this._updateWindowTitleStyle();
        box.add_child(this._dtpIconContainer);
        box.add_child(this._windowTitle);
        this._dotsContainer.add_child(box);
      } else {
        this._dotsContainer.add_child(this._dtpIconContainer);
      }
      this._container.add_child(this._dotsContainer);
      this.set_child(this._container);
      if (panel.geom.vertical) {
        this.set_width(panel.geom.innerSize);
      }
      // Monitor windows-changes instead of app state.
      // Keep using the same Id and function callback (that is extended)
      if (this._stateChangedId > 0) {
        this.app.disconnect(this._stateChangedId);
        this._stateChangedId = 0;
      }
      this._onAnimateAppiconHoverChanged();
      this._onAppIconHoverHighlightChanged();
      this._setAppIconPadding();
      this._showDots();
      this._numberOverlay();
      this._signalsHandler.add(
        [
          this,
          "notify::pressed",
          () => {
            if (this.pressed && this._dtpIconContainer) {
              Utils.stopAnimations(this._dtpIconContainer);
              this._dtpIconContainer.set_scale(1, 1);
              Utils.animate(this._dtpIconContainer, {
                scale_x: 0.9,
                scale_y: 0.9,
                time: 0.1,
                transition: "easeOutQuad",
              });
            } else if (this._dtpIconContainer) {
              Utils.animate(this._dtpIconContainer, {
                scale_x: 1,
                scale_y: 1,
                time: 0.13,
                transition: "easeOutBack",
              });
            }
          },
        ],
        [
          this,
          "notify::mapped",
          () => (this.mapped ? this._handleNotifications() : null),
        ],
        [
          Utils.getStageTheme(),
          "changed",
          this._updateWindowTitleStyle.bind(this),
        ],
        [
          global.display,
          "notify::focus-window",
          this._onFocusAppChanged.bind(this),
        ],
        [this.app, "windows-changed", this.onWindowsChanged.bind(this)]
      );

      if (!this.window) {
        if (SETTINGS.get_boolean("isolate-monitors")) {
          this._signalsHandler.add([
            Utils.DisplayWrapper.getScreen(),
            ["window-entered-monitor", "window-left-monitor"],
            this.onWindowEnteredOrLeft.bind(this),
          ]);
        }

        this._signalsHandler.add([
          Utils.DisplayWrapper.getScreen(),
          "in-fullscreen-changed",
          () => {
            if (
              global.display.focus_window?.get_monitor() ==
              this.dtpPanel.monitor.index &&
              !this.dtpPanel.monitor.inFullscreen
            ) {
              this._resetDots(true);
              this._displayProperIndicator();
            }
          },
        ]);
      } else {
        this._signalsHandler.add(
          [this.window, "notify::title", this._updateWindowTitle.bind(this)],
          [
            this.window,
            "notify::minimized",
            this._updateWindowTitleStyle.bind(this),
          ]
        );
      }

      this._signalsHandler.add(
        [this, "scroll-event", this._onMouseScroll.bind(this)],
        [
          Main.overview,
          "window-drag-end",
          this._onOverviewWindowDragEnd.bind(this),
        ],
        [
          this,
          "notify::hover",
          () => {
            this._onAppIconHoverChanged();
            this._onAppIconHoverChanged_GtkWorkaround();
          },
        ],
        [
          this,
          "notify::pressed",
          this._onAppIconPressedChanged_GtkWorkaround.bind(this),
        ],
        [
          this.dtpPanel.panelManager.notificationsMonitor,
          `update-${this.app.id}`,
          this._handleNotifications.bind(this),
        ],
        [
          SETTINGS,
          "changed::progress-show-count",
          this._handleNotifications.bind(this),
        ],
        [
          SETTINGS,
          "changed::animate-appicon-hover",
          () => {
            this._onAnimateAppiconHoverChanged();
            this._onAppIconHoverHighlightChanged();
          },
        ],
        [
          SETTINGS,
          [
            "changed::highlight-appicon-hover",
            "changed::highlight-appicon-hover-background-color",
            "changed::highlight-appicon-pressed-background-color",
            "changed::highlight-appicon-hover-border-radius",
          ],
          this._onAppIconHoverHighlightChanged.bind(this),
        ],
        [
          SETTINGS,
          [
            "changed::dot-position",
            "changed::dot-size",
            "changed::dot-style-focused",
            "changed::dot-style-unfocused",
            "changed::dot-color-dominant",
            "changed::dot-color-override",
            "changed::dot-color-1",
            "changed::dot-color-2",
            "changed::dot-color-3",
            "changed::dot-color-4",
            "changed::dot-color-unfocused-different",
            "changed::dot-color-unfocused-1",
            "changed::dot-color-unfocused-2",
            "changed::dot-color-unfocused-3",
            "changed::dot-color-unfocused-4",
            "changed::focus-highlight",
            "changed::focus-highlight-dominant",
            "changed::focus-highlight-color",
            "changed::focus-highlight-opacity",
            "changed::group-apps-underline-unfocused",
          ],
          this._settingsChangeRefresh.bind(this),
        ],
        [
          SETTINGS,
          [
            "changed::group-apps-label-font-size",
            "changed::group-apps-label-font-weight",
            "changed::group-apps-label-font-color",
            "changed::group-apps-label-font-color-minimized",
            "changed::group-apps-label-max-width",
            "changed::group-apps-use-fixed-width",
          ],
          this._updateWindowTitleStyle.bind(this),
        ],
        [
          SETTINGS,
          "changed::highlight-appicon-hover-border-radius",
          () => this._setIconStyle(this._isFocusedWindow()),
        ]
      );
    }

    getDragActor() {
      return this.app.create_icon_texture(this.dtpPanel.taskbar.iconSize);
    }

    // Used by TaskbarItemContainer to animate appIcons on hover
    getCloneButton() {
      // The source of the clone is this._dtpIconContainer,
      // which contains the icon but no highlighting elements
      // using this.actor directly would break DnD style.
      let cloneSource = this._dtpIconContainer;
      let clone = new Clutter.Clone({
        source: cloneSource,
        x: this.child.x,
        y: this.child.y,
        width: cloneSource.width,
        height: cloneSource.height,
        pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        opacity: 255,
        reactive: false,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      clone._delegate = this._delegate;

      // "clone" of this.actor
      return new St.Button({
        child: clone,
        x: this.x,
        y: this.y,
        width: this.width,
        height: this.height,
        reactive: false,
      });
    }

    shouldShowTooltip() {
      if (
        !SETTINGS.get_boolean("show-tooltip") ||
        (!this.isLauncher &&
          SETTINGS.get_boolean("show-window-previews") &&
          this.getAppIconInterestingWindows().length > 0)
      ) {
        return false;
      } else {
        return (
          this.hover &&
          !this.window &&
          (!this._menu || !this._menu.isOpen) &&
          this._previewMenu.getCurrentAppIcon() !== this
        );
      }
    }

    _onAppIconHoverChanged() {
      if (
        !SETTINGS.get_boolean("show-window-previews") ||
        (!this.window && !this._nWindows)
      ) {
        return;
      }

      if (this.hover) {
        this._previewMenu.requestOpen(this);
      } else {
        this._previewMenu.requestClose();
      }
    }

    _onDestroy() {
      super._onDestroy();

      if (this._updateIconIdleId) {
        GLib.source_remove(this._updateIconIdleId);
        this._updateIconIdleId = 0;
      }

      this._timeoutsHandler.destroy();
      this._signalsHandler.destroy();

      this._previewMenu.close(true);
    }

    onWindowsChanged() {
      this._updateWindows();
      this.updateIcon();

      if (this._isGroupApps) this._setIconStyle();
    }

    onWindowEnteredOrLeft(display, number, metaWindow) {
      if (number > 0 && tracker.get_window_app(metaWindow) == this.app) {
        this._updateWindows();
        this._displayProperIndicator();
      }
    }

    updateTitleStyle() {
      this._updateWindowTitleStyle();
    }

    // Update indicator and target for minimization animation
    updateIcon() {
      // If (for unknown reason) the actor is not on the stage the reported size
      // and position are random values, which might exceeds the integer range
      // resulting in an error when assigned to the a rect. This is a more like
      // a workaround to prevent flooding the system with errors.
      if (this.get_stage() == null || this._updateIconIdleId) return;

      this._updateIconIdleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        let rect = new Mtk.Rectangle();

        [rect.x, rect.y] = this.get_transformed_position();
        [rect.width, rect.height] = this.get_transformed_size();

        let windows = this.window
          ? [this.window]
          : this.getAppIconInterestingWindows(true);

        windows.forEach(function (w) {
          w.set_icon_geometry(rect);
        });

        this._updateIconIdleId = 0;

        return GLib.SOURCE_REMOVE;
      });
    }

    _onAnimateAppiconHoverChanged() {
      if (SETTINGS.get_boolean("animate-appicon-hover")) {
        this._container.add_style_class_name("animate-appicon-hover");

        // Workaround to prevent scaled icon from being ugly when it is animated on hover.
        // It increases the "resolution" of the icon without changing the icon size.
        this.icon.createIcon = (iconSize) =>
          this.app.create_icon_texture(2 * iconSize);
        this._iconIconBinActorAddedId = this.icon._iconBin.connect(
          "child-added",
          () => {
            let size = this.icon.iconSize * Utils.getScaleFactor();

            if (this.icon._iconBin.child.mapped) {
              this.icon._iconBin.child.set_size(size, size);
            } else {
              let iconMappedId = this.icon._iconBin.child.connect(
                "notify::mapped",
                () => {
                  this.icon._iconBin.child.set_size(size, size);
                  this.icon._iconBin.child.disconnect(iconMappedId);
                }
              );
            }
          }
        );
        if (this.icon._iconBin.child)
          this.icon._createIconTexture(this.icon.iconSize);
      } else {
        this._container.remove_style_class_name("animate-appicon-hover");

        if (this._iconIconBinActorAddedId) {
          this.icon._iconBin.disconnect(this._iconIconBinActorAddedId);
          this._iconIconBinActorAddedId = 0;
          this.icon.createIcon = this._createIcon.bind(this);
        }
      }
    }

    _onAppIconHoverHighlightChanged() {
      const background_color = SETTINGS.get_string(
        "highlight-appicon-hover-background-color"
      );
      const pressed_color = SETTINGS.get_string(
        "highlight-appicon-pressed-background-color"
      );
      const border_radius = SETTINGS.get_int(
        "highlight-appicon-hover-border-radius"
      );

      // Some trickery needed to get the effect
      const br = border_radius ? `border-radius: ${border_radius}px;` : "";
      const ring = "box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06) inset;";
      const transition = "transition: all 0.25s ease-in-out;";

      this._appicon_normalstyle = `${br} ${transition}`;
      this._container.set_style(this._appicon_normalstyle);
      this._appicon_hoverstyle = `background-color: ${background_color}; ${br} ${ring} ${transition}`;
      this._appicon_pressedstyle = `background-color: ${pressed_color}; ${br} ${ring} ${transition}`;

      if (SETTINGS.get_boolean("highlight-appicon-hover")) {
        this._container.remove_style_class_name("no-highlight");
      } else {
        this._container.add_style_class_name("no-highlight");
        this._appicon_normalstyle = "";
        this._appicon_hoverstyle = "";
        this._appicon_pressedstyle = "";
      }
    }

    _onAppIconHoverChanged_GtkWorkaround() {
      if (this.hover && this._appicon_hoverstyle) {
        this._container.set_style(this._appicon_hoverstyle);
      } else if (this._appicon_normalstyle) {
        this._container.set_style(this._appicon_normalstyle);
      } else {
        this._container.set_style("");
      }
    }

    _onAppIconPressedChanged_GtkWorkaround() {
      if (this.pressed && this._appicon_pressedstyle) {
        this._container.set_style(this._appicon_pressedstyle);
      } else if (this.hover && this._appicon_hoverstyle) {
        this._container.set_style(this._appicon_hoverstyle);
      } else if (this._appicon_normalstyle) {
        this._container.set_style(this._appicon_normalstyle);
      } else {
        this._container.set_style("");
      }
    }

    _onMouseScroll(actor, event) {
      let scrollAction = SETTINGS.get_string("scroll-icon-action");

      if (scrollAction === "PASS_THROUGH") {
        return this.dtpPanel._onPanelMouseScroll(actor, event);
      } else if (
        scrollAction === "NOTHING" ||
        (!this.window && !this._nWindows)
      ) {
        return;
      }

      let direction = Utils.getMouseScrollDirection(event);

      if (direction && !this._timeoutsHandler.getId(T2)) {
        this._timeoutsHandler.add([
          T2,
          SETTINGS.get_int("scroll-icon-delay"),
          () => { },
        ]);

        let windows = this.getAppIconInterestingWindows();

        windows.sort(Taskbar.sortWindowsCompareFunction);
        Utils.activateSiblingWindow(windows, direction, this.window);
      }
    }

    _showDots() {
      // Just update style if dots already exist
      if (this._focusedDots && this._unfocusedDots) {
        this._updateWindows();
        return;
      }

      if (!this._isGroupApps) {
        this._focusedDots = new St.Widget({
          layout_manager: new Clutter.BinLayout(),
          x_expand: true,
          y_expand: true,
          visible: false,
        });

        let mappedId = this.connect("notify::mapped", () => {
          this._displayProperIndicator();
          this.disconnect(mappedId);
        });
      } else {
        (this._focusedDots = new St.DrawingArea()),
          (this._unfocusedDots = new St.DrawingArea());

        this._focusedDots.connect("repaint", () => {
          if (!this._dashItemContainer.animatingOut)
            // don't draw and trigger more animations if the icon is in the middle of
            // being removed from the panel
            this._drawRunningIndicator(
              this._focusedDots,
              "METRO",
              true
            );
        });

        this._unfocusedDots.connect("repaint", () => {
          if (!this._dashItemContainer.animatingOut)
            this._drawRunningIndicator(
              this._unfocusedDots,
              "DASHES",
              false
            );
        });

        this._dotsContainer.add_child(this._unfocusedDots);

        this._updateWindows();

        this._timeoutsHandler.add([
          T3,
          0,
          () => {
            this._resetDots();
            this._displayProperIndicator();
          },
        ]);
      }

      this._dotsContainer.add_child(this._focusedDots);
    }
    _resetDots(ignoreSizeReset) {
      let position = "BOTTOM";
      let isHorizontalDots = position == "BOTTOM";
      let sizeProp = isHorizontalDots ? "width" : "height";
      let focusedDotStyle = "METRO";
      let unfocusedDotStyle = "DASHES";
      this._focusedIsWide = this._isWideDotStyle(focusedDotStyle);
      this._unfocusedIsWide = this._isWideDotStyle(unfocusedDotStyle);
      [, this._containerSize] =
        this._container[`get_preferred_${sizeProp}`](-1);
      if (!ignoreSizeReset) {
        [this._focusedDots, this._unfocusedDots].forEach((d) => {
          d.set_size(-1, -1);
          d.x_expand = d.y_expand = false;

          d[sizeProp] = 1;
          d[(isHorizontalDots ? "y" : "x") + "_expand"] = true;
        });
      }
    }
    _settingsChangeRefresh() {
      if (this._isGroupApps) {
        this._updateWindows();
        this._resetDots();
        this._focusedDots.queue_repaint();
        this._unfocusedDots.queue_repaint();
      }
      this._displayProperIndicator();
    }
    _updateWindowTitleStyle() {
      if (this._windowTitle) {
        let useFixedWidth = SETTINGS.get_boolean("group-apps-use-fixed-width");
        let fontWeight = SETTINGS.get_string("group-apps-label-font-weight");
        let fontScale = DESKTOPSETTINGS.get_double("text-scaling-factor");
        let fontColor = this.window.minimized
          ? SETTINGS.get_string("group-apps-label-font-color-minimized")
          : SETTINGS.get_string("group-apps-label-font-color");
        let scaleFactor = Utils.getScaleFactor();
        let maxLabelWidth =
          SETTINGS.get_int("group-apps-label-max-width") * scaleFactor;
        let variableWidth =
          !useFixedWidth ||
          this.dtpPanel.geom.vertical ||
          this.dtpPanel.taskbar.fullScrollView;
        this._windowTitle[maxLabelWidth > 0 ? "show" : "hide"]();
        this._windowTitle.set_width(
          variableWidth ? -1 : maxLabelWidth + TITLE_RIGHT_PADDING * scaleFactor
        );
        this._windowTitle.clutter_text.natural_width = useFixedWidth
          ? maxLabelWidth
          : 0;
        this._windowTitle.clutter_text.natural_width_set = useFixedWidth;
        this._windowTitle.set_style(
          "font-size: " +
          SETTINGS.get_int("group-apps-label-font-size") * fontScale +
          "px;" +
          "font-weight: " +
          fontWeight +
          ";" +
          (useFixedWidth ? "" : "max-width: " + maxLabelWidth + "px;") +
          "color: " +
          fontColor
        );
      }
    }
    _updateWindowTitle() {
      if (this._windowTitle.text != this.window.title) {
        this._windowTitle.text = (
          this.window.title ? this.window.title : this.app.get_name()
        )
          .replace(/\r?\n|\r/g, "")
          .trim();
        if (this._focusedDots) {
          this._displayProperIndicator();
        }
      }
    }
    _setIconStyle(isFocused) {
      let inlineStyle = "margin: 0;";
      if (
        SETTINGS.get_boolean("focus-highlight") &&
        this._checkIfFocusedApp() &&
        !this.isLauncher &&
        (!this.window || isFocused) &&
        !this._isThemeProvidingIndicator() &&
        this._checkIfMonitorHasFocus()
      ) {
        let focusedDotStyle = "METRO";
        let pos = "BOTTOM";
        let highlightMargin = this._focusedIsWide
          ? SETTINGS.get_int("dot-size")
          : 0;
        if (!this.window) {
          let containerWidth =
            this._dtpIconContainer.get_width() / Utils.getScaleFactor();
          let backgroundSize =
            containerWidth +
            "px " +
            (containerWidth -
              (pos == "BOTTOM" ? highlightMargin : 0)) +
            "px;";
          if (this._nWindows > 1 && focusedDotStyle == "METRO") {
            let bgSvg = "/img/highlight_stacked_bg";
            inlineStyle +=
              "background-image: url('" +
              EXTENSION_PATH +
              bgSvg +
              ".svg');" +
              "background-position: 0 " +
              0 +
              "px;" +
              "background-size: " +
              backgroundSize;
          } 
        }
        let highlightColor = this._getFocusHighlightColor();
        inlineStyle +=
          "background-color: " +
          cssHexTocssRgba(
            highlightColor,
            SETTINGS.get_int("focus-highlight-opacity") * 0.01
          ) +
          ";";
        inlineStyle += "box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08) inset;";
        inlineStyle += this._appicon_normalstyle;
      }
      if (this._dotsContainer.get_style() != inlineStyle) {
        this._dotsContainer.set_style(inlineStyle);
      }
    }
    _checkIfFocusedApp() {
      return tracker.focus_app == this.app;
    }
    _checkIfMonitorHasFocus() {
      return (
        global.display.focus_window &&
        (!true ||
          !true ||
          global.display.focus_window.get_monitor() ===
          this.dtpPanel.monitor.index)
      );
    }
    _setAppIconPadding() {
      this._iconContainer.set_style(
        `padding-left: 5px; padding-right: 5px;`
      );
    }
    popupMenu() {
      this._removeMenuTimeout();
      this.fake_release();
      if (!this._menu) {
        this._menu = new TaskbarSecondaryMenu(
          this,
          this.dtpPanel.geom.position
        );
        this._menu.setApp(this.app);
        this._signalsHandler.add(
          [
            this._menu,
            "open-state-changed",
            (menu, isPoppedUp) => {
              if (!isPoppedUp) this._onMenuPoppedDown();
              else this._previewMenu.close(true);
            },
          ],
          [Main.overview, "hiding", () => this._menu.close()]
        );
        this._menu.blockSourceEvents = true;
        Main.uiGroup.add_child(this._menu.actor);
        this._menuManager.addMenu(this._menu);
      }
      this._menu.updateQuitItems();
      this.emit("menu-state-changed", true);
      this.set_hover(true);
      this._menu.open(BoxPointer.PopupAnimation.FULL);
      this._menuManager.ignoreRelease();
      this.emit("sync-tooltip");

      return false;
    }
    _onFocusAppChanged() {
      this._displayProperIndicator();
    }
    _onOverviewWindowDragEnd() {
      this._timeoutsHandler.add([
        T4,
        0,
        () => {
          if (SETTINGS.get_boolean("isolate-workspaces")) this._updateWindows();

          this._displayProperIndicator();
        },
      ]);
    }

    _onSwitchWorkspace() {
      if (this._isGroupApps) {
        this._timeoutsHandler.add([
          T5,
          0,
          () => this._displayProperIndicator(),
        ]);
      } else {
        this._displayProperIndicator();
      }
    }

    _displayProperIndicator() {
      let isFocused = this._isFocusedWindow();
      let position = "BOTTOM";
      let isHorizontalDots = position == "BOTTOM";
      this._setIconStyle(isFocused);
      if (!this._isGroupApps) {
        if (
          this.window &&
          (SETTINGS.get_boolean("group-apps-underline-unfocused") || isFocused)
        ) {
          let align =
            Clutter.ActorAlign[
            position == "TOP" || position == DOT_POSITION.LEFT
              ? "START"
              : "END"
            ];
          this._focusedDots.set_size(0, 0);
          // UZUNLUK: Focus varsa uzunluğu artır, yoksa normal bırak
          let baseLength = this._containerSize * 0.5; // normal uzunluk (ikonun yarısı kadar)
          let focusedLength = this._containerSize * 2; // focus olunca neredeyse tam uzunluk
          this._focusedDots[isHorizontalDots ? "width" : "height"] =
            isFocused ? focusedLength : baseLength;
          this._focusedDots[isHorizontalDots ? "height" : "width"] =
            this._getRunningIndicatorSize();
          this._focusedDots.y_align = this._focusedDots.x_align =
            Clutter.ActorAlign.FILL;
          this._focusedDots[(isHorizontalDots ? "y" : "x") + "_align"] = align;
          this._focusedDots.background_color =
            this._getRunningIndicatorColor(isFocused);
          this._focusedDots.show();
        }
      } else {
        let sizeProp = isHorizontalDots ? "width" : "height";
        let newFocusedDotsSize = 0;
        let newFocusedDotsOpacity = 0;
        let newUnfocusedDotsSize = 0;
        let newUnfocusedDotsOpacity = 0;
        isFocused = this._checkIfFocusedApp() && this._checkIfMonitorHasFocus();
        this._timeoutsHandler.add([
          T6,
          0,
          () => {
            if (isFocused) this.add_style_class_name("focused");
            else this.remove_style_class_name("focused");
          },
        ]);
        if (this._focusedIsWide) {
          newFocusedDotsSize =
            isFocused && this._nWindows > 0 ? this._containerSize : 0;
          newFocusedDotsOpacity = 255; // Her zaman görünür
        } else {
          newFocusedDotsSize = this._containerSize;
          newFocusedDotsOpacity = 255; // Her zaman görünür
        }
        if (this._unfocusedIsWide) {
          newUnfocusedDotsSize =
            !isFocused && this._nWindows > 0 ? this._containerSize : 0;
          newUnfocusedDotsOpacity = 255;
        } else {
          newUnfocusedDotsSize = this._containerSize;
          newUnfocusedDotsOpacity = 255;
        }
        let duration = 0.155;
        this._animateDotDisplay(
          this._focusedDots,
          newFocusedDotsSize,
          this._unfocusedDots,
          newUnfocusedDotsOpacity,
          sizeProp,
          duration
        );
        this._animateDotDisplay(
          this._unfocusedDots,
          newUnfocusedDotsSize,
          this._focusedDots,
          newFocusedDotsOpacity,
          sizeProp,
          duration
        );
      }
    }
    _animateDotDisplay(
      dots,
      newSize,
      otherDots,
      newOtherOpacity,
      sizeProp,
      duration
    ) {
      Utils.stopAnimations(dots);
      let tweenOpts = {
        time: duration,
        transition: "easeInOut",
        onComplete: () => {
          if (newOtherOpacity > 0) otherDots.opacity = newOtherOpacity;
        },
      };
      if (newOtherOpacity == 0) otherDots.opacity = newOtherOpacity;
      tweenOpts[sizeProp] = newSize;
      Utils.animate(dots, tweenOpts);
    }
    _isFocusedWindow() {
      let focusedWindow = global.display.focus_window;
      while (focusedWindow) {
        if (focusedWindow == this.window) {
          return true;
        }
        focusedWindow = focusedWindow.get_transient_for();
      }
      return false;
    }
    _isWideDotStyle(dotStyle) {
      return dotStyle == "METRO";
    }
    _isThemeProvidingIndicator() {
      return (
        this.icon.get_stage() && this.icon.get_theme_node().get_border_image()
      );
    }
    activate(button, modifiers, handleAsGrouped) {
      let event = Clutter.get_current_event();
      modifiers = event ? event.get_state() : modifiers || 0;
      // Only consider SHIFT and CONTROL as modifiers (exclude SUPER, CAPS-LOCK, etc.)
      modifiers =
        modifiers &
        (Clutter.ModifierType.CONTROL_MASK);
      let ctrlPressed = modifiers & Clutter.ModifierType.CONTROL_MASK;
      if (ctrlPressed) {
        return this._launchNewInstance(true);
      }
      let buttonAction = 0;
      let doubleClick;
      if (button && button == 2) {
        if (modifiers & Clutter.ModifierType.SHIFT_MASK)
          buttonAction = SETTINGS.get_string("shift-middle-click-action");
        else buttonAction = SETTINGS.get_string("middle-click-action");
      }
      else if (button === 0 || button === 1) {
        let now = global.get_current_time();
        doubleClick = now - this.lastClick < DOUBLE_CLICK_DELAY_MS;
        this.lastClick = now;
        if (modifiers & Clutter.ModifierType.SHIFT_MASK)
          buttonAction = SETTINGS.get_string("shift-click-action");
        else buttonAction = SETTINGS.get_string("click-action");
      }
      let closePreview = () =>
        this._previewMenu.close(
          SETTINGS.get_boolean("window-preview-hide-immediate-click")
        );
      let appCount = this.getAppIconInterestingWindows().length;
      let previewedAppIcon = this._previewMenu.getCurrentAppIcon();
      if (this.window || buttonAction != "TOGGLE-SHOWPREVIEW") closePreview();
      // We check if the app is running, and that the # of windows is > 0 in
      // case we use workspace isolation,
      let appIsRunning =
        this.app.state == Shell.AppState.RUNNING && appCount > 0;
      if (appIsRunning && !this.isLauncher) {
        if (this.window && !handleAsGrouped) {
          switch (buttonAction) {
            case "LAUNCH":
              this._launchNewInstance();
              break;
            case "QUIT":
              this.window.delete(global.get_current_time());
              break;
            default:
              if (
                !Main.overview._shown &&
                (buttonAction == "MINIMIZE" ||
                  buttonAction == "TOGGLE-CYCLE" ||
                  buttonAction == "CYCLE-MIN") &&
                (this._isFocusedWindow() ||
                  (buttonAction == "MINIMIZE" &&
                    (button == 2 ||
                      modifiers & Clutter.ModifierType.SHIFT_MASK)))
              ) {
                this.window.minimize();
              } else {
                Main.activateWindow(this.window);
              }
          }
        } else {
          //grouped application behaviors
          let monitor = this.dtpPanel.monitor;
          let appHasFocus =
            this._checkIfFocusedApp() && this._checkIfMonitorHasFocus();
          switch (buttonAction) {
            case "RAISE":
              activateAllWindows(this.app, monitor);
              break;
            case "LAUNCH":
              this._launchNewInstance();
              break;
            case "MINIMIZE":
              // In overview just activate the app, unless the acion is explicitely
              // requested with a keyboard modifier
              if (!Main.overview._shown || modifiers) {
                // If we have button=2 or a modifier, allow minimization even if
                // the app is not focused
                if (
                  appHasFocus ||
                  button == 2 ||
                  modifiers & Clutter.ModifierType.SHIFT_MASK
                ) {
                  // minimize all windows on double click and always in the case of primary click without
                  // additional modifiers
                  let all_windows = (button == 1 && !modifiers) || doubleClick;
                  minimizeWindow(this.app, all_windows, monitor);
                } else activateAllWindows(this.app, monitor);
              } else this.app.activate();
              break;
            case "CYCLE":
              if (!Main.overview._shown) {
                if (appHasFocus)
                  cycleThroughWindows(this.app, false, false, monitor);
                else {
                  activateFirstWindow(this.app, monitor);
                }
              } else this.app.activate();
              break;
            case "CYCLE-MIN":
              if (!Main.overview._shown) {
                if (
                  appHasFocus ||
                  (recentlyClickedApp == this.app &&
                    recentlyClickedAppWindows[
                    recentlyClickedAppIndex % recentlyClickedAppWindows.length
                    ] == "MINIMIZE")
                )
                  cycleThroughWindows(this.app, false, true, monitor);
                else {
                  activateFirstWindow(this.app, monitor);
                }
              } else this.app.activate();
              break;
            case "TOGGLE-SHOWPREVIEW":
              if (!Main.overview._shown) {
                if (appCount == 1) {
                  closePreview();

                  if (appHasFocus) minimizeWindow(this.app, false, monitor);
                  else activateFirstWindow(this.app, monitor);
                } else {
                  if (doubleClick) {
                    // minimize all windows if double clicked
                    closePreview();
                    minimizeWindow(this.app, true, monitor);
                  } else if (previewedAppIcon != this) {
                    this._previewMenu.open(this);
                  }

                  this.emit("sync-tooltip");
                }
              } else this.app.activate();
              break;
            case "TOGGLE-CYCLE":
              if (!Main.overview._shown) {
                if (appCount == 1) {
                  if (appHasFocus) minimizeWindow(this.app, false, monitor);
                  else activateFirstWindow(this.app, monitor);
                } else {
                  cycleThroughWindows(this.app, false, false, monitor);
                }
              } else this.app.activate();
              break;
            case "QUIT":
              closeAllWindows(this.app, monitor);
              break;
            case "TOGGLE-SPREAD":
              if (appCount == 1) {
                if (appHasFocus && !Main.overview._shown)
                  minimizeWindow(this.app, false, monitor);
                else activateFirstWindow(this.app, monitor);
              } else
                // return so the overview stays open if it already is
                return this.dtpPanel.panelManager.showFocusedAppInOverview(
                  this.app
                );
          }
        }
      } else {
        this._launchNewInstance();
      }

      global.display.emit("grab-op-begin", null, null);
      Main.overview.hide();
    }

    _launchNewInstance(ctrlPressed) {
      let maybeAnimate = () =>
        SETTINGS.get_boolean("animate-window-launch") && this.animateLaunch();

      if (
        (ctrlPressed || this.app.state == Shell.AppState.RUNNING) &&
        this.app.can_open_new_window()
      ) {
        maybeAnimate();
        this.app.open_new_window(-1);
      } else {
        let windows = this.window ? [this.window] : this.app.get_windows();

        if (windows.length) {
          Main.activateWindow(windows[0]);
        } else {
          maybeAnimate();
          this.app.activate();
        }
      }
    }

    _updateWindows() {
      let windows = [this.window];

      if (!this.window) {
        windows = this.getAppIconInterestingWindows();

        this._nWindows = windows.length;

        for (let i = 1; i <= MAX_INDICATORS; i++) {
          let className = "running" + i;
          if (i != this._nWindows) this.remove_style_class_name(className);
          else this.add_style_class_name(className);
        }
      }

      this._previewMenu.update(this, windows);
    }

    _getRunningIndicatorCount() {
      return this._nWindows > 0 ? 1 : 0;
    }

    _getRunningIndicatorSize() {
      return SETTINGS.get_int("dot-size") * Utils.getScaleFactor();
    }

    _getRunningIndicatorColor(isFocused) {
      let color;
      const fallbackColor = new Utils.ColorUtils.Color({
        red: 82,
        green: 148,
        blue: 226,
        alpha: 255,
      });

      if (SETTINGS.get_boolean("dot-color-dominant")) {
        let dce = new Utils.DominantColorExtractor(this.app);
        let palette = dce._getColorPalette();
        if (palette) {
          color = Utils.ColorUtils.color_from_string(palette.original)[1];
        } else {
          // unable to determine color, fall back to theme
          let themeNode = this._dot.get_theme_node();
          color = themeNode.get_background_color();

          // theme didn't provide one, use a default
          if (color.alpha == 0) color = fallbackColor;
        }
      } else if (SETTINGS.get_boolean("dot-color-override")) {
        let dotColorSettingPrefix = "dot-color-";

        if (!isFocused && SETTINGS.get_boolean("dot-color-unfocused-different"))
          dotColorSettingPrefix = "dot-color-unfocused-";

        color = Utils.ColorUtils.color_from_string(
          SETTINGS.get_string(
            dotColorSettingPrefix + (this._getRunningIndicatorCount() || 1)
          )
        )[1];
      } else {
        // Re-use the style - background color, and border width and color -
        // of the default dot
        let themeNode = this._dot.get_theme_node();
        color = themeNode.get_background_color();

        // theme didn't provide one, use a default
        if (color.alpha == 0) color = fallbackColor;
      }

      return color;
    }

    _getFocusHighlightColor() {
      return SETTINGS.get_string("focus-highlight-color");
    }

    _cairoRoundedRect(cr, x, y, w, h, r) {
      cr.moveTo(x + r, y);
      cr.lineTo(x + w - r, y);
      cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
      cr.lineTo(x + w, y + h - r);
      cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
      cr.lineTo(x + r, y + h);
      cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
      cr.lineTo(x, y + r);
      cr.arc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2);
      cr.closePath();
    }

    _drawRunningIndicator(area, type, isFocused) {
      let n = this._getRunningIndicatorCount();
      if (!n) {
        return;
      }
      let position = "BOTTOM";
      let isHorizontalDots =
        position == "TOP" || position == "BOTTOM";
      let bodyColor = this._getRunningIndicatorColor(isFocused);
      let [areaWidth, areaHeight] = area.get_surface_size();
      let cr = area.get_context();
      let size = this._getRunningIndicatorSize();
      let areaSize = areaWidth;
      let startX = 0;
      let startY = 0;
      if (isHorizontalDots) {
        if (position == "BOTTOM") {
          startY = areaHeight - size;
        }
      } else {
        areaSize = areaHeight;
      }
      let baseLength = areaSize * 0.6;
      let focusedLength = areaSize * 0.42;
      let indicatorLength = isFocused ? focusedLength : baseLength;
      if (type == "METRO") {
        let spacing = Math.ceil(areaSize / 18);
        let length = indicatorLength - spacing;
        let dist;
        let indicatorSize;
        let translate;
        let preDraw = () => { };
        let draw;
        length = indicatorLength - spacing;
        translate = () => {
          indicatorSize = Math.floor(
            (areaSize - n * length - (n - 1) * spacing) / 2
          );
          cr.translate.apply(
            cr,
            isHorizontalDots
              ? [indicatorSize, startY]
              : [startX, indicatorSize]
          );
        };
        draw = (i) => {
          dist = i * length + i * spacing;
          let radius = Math.min(6, length / 2, size / 2);
          cr.newSubPath();
          if (isHorizontalDots) {
            this._cairoRoundedRect(cr, dist, 0, length, size, radius);
          } else {
            this._cairoRoundedRect(cr, 0, dist, size, length, radius);
          }
        };
        translate();
        cr.setSourceColor(bodyColor);
        preDraw();
        for (let i = 0; i < n; i++) {
          cr.newSubPath();
          draw(i);
        }
        cr.fill();
      } else {
        let spacing = Math.ceil(areaSize / 18);
        let length = indicatorLength - spacing;;
        let dist;
        let indicatorSize;
        let translate;
        let preDraw = () => { };
        let draw;
        length = Math.floor(areaSize / 3.81) - spacing;
        translate = () => {
          indicatorSize = Math.floor(
            (areaSize - n * length - (n - 1) * spacing) / 2
          );
          cr.translate.apply(
            cr,
            isHorizontalDots ? [indicatorSize, startY] : [startX, indicatorSize]
          );
        };
        draw = (i) => {
          dist = i * length + i * spacing;
          let radius = Math.min(6, length / 2, size / 2);
          cr.newSubPath();
          if (isHorizontalDots) {
            this._cairoRoundedRect(cr, dist, 0, length, size, radius);
          } else {
            this._cairoRoundedRect(cr, 0, dist, size, length, radius);
          }
        };
        translate();
        cr.setSourceColor(bodyColor);
        preDraw();
        for (let i = 0; i < n; i++) {
          cr.newSubPath();
          draw(i);
        }
        cr.fill();
      }
      cr.$dispose();
    }
    _handleNotifications() {
      if (!this._nWindows && !this.window) return;
      let monitor = this.dtpPanel.panelManager.notificationsMonitor;
      let state = monitor.getState(this.app);
      let count = 0;
      if (!state) return;
      if (SETTINGS.get_boolean("progress-show-count")) {
        this.iconAnimator[`${state.urgent ? "add" : "remove"}Animation`](
          this.icon._iconBin,
          "dance"
        );
      }
      this._notificationsCount = count;
      this._maybeUpdateNumberOverlay();
    }
    _maybeUpdateNumberOverlay() {
      let visible = this._numberOverlayBin.visible;
      let shouldBeVisible =
        (this._hotkeysOverlayActiveMode &&
          this._numberHotkeysOverlayLabel > -1) ||
        this._notificationsCount;

      let showNotifications =
        this._notificationsCount &&
        this._hotkeysOverlayActiveMode !== "TEMPORARILY";
      let label = showNotifications
        ? this._notificationsCount
        : this._numberHotkeysOverlayLabel;

      this._numberOverlayLabel[
        `${showNotifications ? "add" : "remove"}_style_class_name`
      ]("notification-badge");

      if (shouldBeVisible && label !== this._numberOverlayLabel.get_text()) {
        this._numberOverlayLabel.set_text(label.toString());
        this._updateNumberOverlay();
      }

      if (visible && !shouldBeVisible) this._numberOverlayBin.hide();
      else if (!visible && shouldBeVisible) this._numberOverlayBin.show();
    }

    _numberOverlay() {
      // Add label for a numeric visual aid (hotkeys or notification)
      this._numberOverlayLabel = new St.Label({ style_class: "badge" });
      this._numberOverlayBin = new St.Bin({
        child: this._numberOverlayLabel,
        y: 2,
      });
      this._numberOverlayLabel.add_style_class_name("number-overlay");
      this._numberHotkeysOverlayLabel = -1;
      this._numberOverlayBin.hide();

      this._dtpIconContainer.add_child(this._numberOverlayBin);
    }

    _updateNumberOverlay() {
      // We apply an overall scale factor that might come from a HiDPI monitor.
      // Clutter dimensions are in physical pixels, but CSS measures are in logical
      // pixels, so make sure to consider the scale.
      // Set the font size to something smaller than the whole icon so it is
      // still visible. The border radius is large to make the shape circular
      let panelSize = this.dtpPanel.geom.iconSize;
      let minFontSize = panelSize >= 32 ? 12 : 10;
      let fontSize = Math.round(
        Math.max(minFontSize, 0.3 * panelSize) / Utils.getScaleFactor()
      );
      let size = Math.round(fontSize * 1.3);
      let style = `
        font-size: ${fontSize}px;
        height: ${size}px;
      `;
      this._numberOverlayLabel.set_style(style);
    }

    setHotkeysNumberOverlayLabel(number) {
      this._numberHotkeysOverlayLabel = number;
    }

    toggleHotkeysNumberOverlay(activateMode) {
      this._hotkeysOverlayActiveMode =
        this._numberHotkeysOverlayLabel > -1 && activateMode;

      this._maybeUpdateNumberOverlay();
    }

    handleDragOver(source) {
      if (source == Main.xdndHandler) {
        this._previewMenu.close(true);

        if (!this._nWindows && !this.window)
          return DND.DragMotionResult.MOVE_DROP;

        if (this._nWindows == 1 || this.window) {
          this.window
            ? Main.activateWindow(this.window)
            : activateFirstWindow(this.app, this.monitor);
        } else
          this.dtpPanel.panelManager.showFocusedAppInOverview(this.app, true);

        return DND.DragMotionResult.MOVE_DROP;
      }

      return DND.DragMotionResult.CONTINUE;
    }

    getAppIconInterestingWindows(isolateMonitors) {
      return getInterestingWindows(
        this.app,
        this.dtpPanel.monitor,
        isolateMonitors
      );
    }
  }
);
TaskbarAppIcon.prototype.scaleAndFade =
  TaskbarAppIcon.prototype.undoScaleAndFade = () => { };

export function minimizeWindow(app, param, monitor) {
  // Param true make all app windows minimize
  let windows = getInterestingWindows(app, monitor);
  let current_workspace =
    Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace();
  for (let i = 0; i < windows.length; i++) {
    let w = windows[i];
    if (
      w.get_workspace() == current_workspace &&
      w.showing_on_its_workspace()
    ) {
      w.minimize();
      // Just minimize one window. By specification it should be the
      // focused window on the current workspace.
      if (!param) break;
    }
  }
}

/*
 * By default only non minimized windows are activated.
 * This activates all windows in the current workspace.
 */
export function activateAllWindows(app, monitor) {
  // First activate first window so workspace is switched if needed,
  // then activate all other app windows in the current workspace.
  let windows = getInterestingWindows(app, monitor);
  let w = windows[0];
  Main.activateWindow(w);
  let activeWorkspace =
    Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace_index();

  if (windows.length <= 0) return;

  for (let i = windows.length - 1; i >= 0; i--) {
    if (windows[i].get_workspace().index() == activeWorkspace) {
      Main.activateWindow(windows[i]);
    }
  }
}

export function activateFirstWindow(app, monitor) {
  let windows = getInterestingWindows(app, monitor);
  Main.activateWindow(windows[0]);
}

export function cycleThroughWindows(app, reversed, shouldMinimize, monitor) {
  // Store for a little amount of time last clicked app and its windows
  // since the order changes upon window interaction
  let MEMORY_TIME = 3000;

  let app_windows = getInterestingWindows(app, monitor);

  if (shouldMinimize) app_windows.push("MINIMIZE");

  if (recentlyClickedAppLoopId > 0)
    GLib.Source.remove(recentlyClickedAppLoopId);

  recentlyClickedAppLoopId = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    MEMORY_TIME,
    resetRecentlyClickedApp
  );

  // If there isn't already a list of windows for the current app,
  // or the stored list is outdated, use the current windows list.
  if (
    !recentlyClickedApp ||
    recentlyClickedApp.get_id() != app.get_id() ||
    recentlyClickedAppWindows.length != app_windows.length ||
    recentlyClickedAppMonitorIndex != monitor.index
  ) {
    recentlyClickedApp = app;
    recentlyClickedAppWindows = app_windows;
    recentlyClickedAppIndex = 0;
    recentlyClickedAppMonitorIndex = monitor.index;
  }

  if (reversed) {
    recentlyClickedAppIndex--;
    if (recentlyClickedAppIndex < 0)
      recentlyClickedAppIndex = recentlyClickedAppWindows.length - 1;
  } else {
    recentlyClickedAppIndex++;
  }
  let index = recentlyClickedAppIndex % recentlyClickedAppWindows.length;

  if (recentlyClickedAppWindows[index] === "MINIMIZE")
    minimizeWindow(app, true, monitor);
  else Main.activateWindow(recentlyClickedAppWindows[index]);
}

export function resetRecentlyClickedApp() {
  if (recentlyClickedAppLoopId > 0)
    GLib.Source.remove(recentlyClickedAppLoopId);

  recentlyClickedAppLoopId = 0;
  recentlyClickedApp = null;
  recentlyClickedAppWindows = null;
  recentlyClickedAppIndex = 0;
  recentlyClickedAppMonitorIndex = null;

  return GLib.SOURCE_REMOVE;
}

export function closeAllWindows(app, monitor) {
  let windows = getInterestingWindows(app, monitor);
  for (let i = 0; i < windows.length; i++)
    windows[i].delete(global.get_current_time());
}

// Filter out unnecessary windows, for instance
// nautilus desktop window.
export function getInterestingWindows(app, monitor, isolateMonitors) {
  let windows = (app ? app.get_windows() : Utils.getAllMetaWindows()).filter(
    (w) => !w.skip_taskbar
  );

  // When using workspace or monitor isolation, we filter out windows
  // that are not in the current workspace or on the same monitor as the appicon
  if (SETTINGS.get_boolean("isolate-workspaces"))
    windows = windows.filter(function (w) {
      return (
        w.get_workspace() && w.get_workspace() == Utils.getCurrentWorkspace()
      );
    });

  if (
    monitor &&
    (isolateMonitors || SETTINGS.get_boolean("isolate-monitors"))
  ) {
    windows = windows.filter(function (w) {
      return w.get_monitor() == monitor.index;
    });
  }

  return windows;
}

export function cssHexTocssRgba(cssHex, opacity) {
  let bigint = parseInt(cssHex.slice(1), 16);
  let r = (bigint >> 16) & 255;
  let g = (bigint >> 8) & 255;
  let b = bigint & 255;

  return "rgba(" + [r, g, b].join(",") + "," + opacity + ")";
}

/**
 * Extend AppMenu (AppIconMenu for pre gnome 41)
 *
 * - hide 'App Details' according to setting
 * - show windows header only if show-window-previews is disabled
 * - Add close windows option based on quitfromdash extension
 *   (https://github.com/deuill/shell-extension-quitfromdash)
 */

export class TaskbarSecondaryMenu extends AppMenu.AppMenu {
  constructor(source, side) {
    super(source, side);
    // constructor parameter does nos work for some reason
    this._enableFavorites = true;
    this._showSingleWindows = true;

    if (source.window)
      this._quitAllItem = this.addAction("QuitAll", () =>
        this._quitFromTaskbar(true)
      );
    // replace quit item
    delete this._quitItem;
    this._quitItem = this.addAction(_("Quit"), () => this._quitFromTaskbar());
    source._signalsHandler.add([
      SETTINGS,
      "changed::secondarymenu-contains-showdetails",
      () => this._setAppDetailsVisibility(source.app),
    ]);
  }
  updateQuitItems() {
    let ungrouped = !!this.sourceActor.window;
    let quitText = _("Quit");
    let count = getInterestingWindows(
      this._app,
      this.sourceActor.dtpPanel.monitor
    ).length;
    let quitMultipleText = ngettext(
      "%d pencereyi kapat",
      "%d pencereyi kapat",
      count
    ).format(count);
    if (ungrouped) {
      this._quitAllItem.label.set_text(quitMultipleText);
      this._quitAllItem.visible = count > 1;
    } else quitText = quitMultipleText;
    this._quitItem.visible = count > 0;
    this._quitItem.label.set_text(quitText);
  }
  _quitFromTaskbar(all) {
    let time = global.get_current_time();
    let windows =
      !all && this.sourceActor.window // ungrouped applications
        ? [this.sourceActor.window]
        : getInterestingWindows(this._app, this.sourceActor.dtpPanel.monitor);
    if (windows.length == this._app.get_windows().length)
      this._app.request_quit();
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      windows.forEach((w) => !!w.get_compositor_private() && w.delete(time++));
      return GLib.SOURCE_REMOVE;
    });
  }
  setApp(app) {
    super.setApp(app);
    this._setAppDetailsVisibility();
  }
  _setAppDetailsVisibility() {
    // This next line sets the app details menu to visible if Gnome Software is
    // installed. If it isn't, no point of showing the menu anyway because
    // its only purpose is to open Gnome Software
    super._updateDetailsVisibility();
    let gnomeSoftwareIsInstalled = this._detailsItem.visible;
    this._detailsItem.visible =
      gnomeSoftwareIsInstalled &&
      SETTINGS.get_boolean("secondarymenu-contains-showdetails");
  }
}

/**
 * This function is used for extendDashItemContainer
 */
export function ItemShowLabel() {
  if (!this._labelText) return;
  this.label.set_text(this._labelText);
  this.label.opacity = 0;
  this.label.show();
  let [stageX, stageY] = this.get_transformed_position();
  let node = this.label.get_theme_node();
  let itemWidth = this.allocation.x2 - this.allocation.x1;
  let itemHeight = this.allocation.y2 - this.allocation.y1;
  let labelWidth = this.label.get_width();
  let labelHeight = this.label.get_height();
  let position = this._dtpPanel.geom.position;
  let labelOffset = node.get_length("-x-offset");

  // From TaskbarItemContainer
  if (this._getIconAnimationOffset)
    labelOffset += this._getIconAnimationOffset();

  let xOffset = Math.floor((itemWidth - labelWidth) / 2);
  let x = stageX + xOffset;
  let y = stageY - labelHeight - labelOffset;
  // keep the label inside the screen border
  // Only needed for the x coordinate.
  // Leave a few pixel gap
  let gap = 199;
  let monitor = Main.layoutManager.findMonitorForActor(this);
  if (x - monitor.x < gap) x += monitor.x - x + labelOffset;
  else if (x + labelWidth > monitor.x + monitor.width - gap)
    x -= x + labelWidth - (monitor.x + monitor.width) + gap;

  this.label.set_position(Math.round(x), Math.round(y));
  let duration = 180;
  if (duration > 1) {
    duration /= 1000;
  }
  Utils.animate(this.label, {
    opacity: 255,
    time: duration,
    transition: "easeInOut",
  });
}

/**
 * A wrapper class around the ShowAppsIcon class.
 *
 * - Pass settings to the constructor
 * - set label position based on dash orientation (Note, I am reusing most machinery of the appIcon class)
 * - implement a popupMenu based on the AppIcon code (Note, I am reusing most machinery of the appIcon class)
 *
 * I can't subclass the original object because of this: https://bugzilla.gnome.org/show_bug.cgi?id=688973.
 * thus use this pattern where the real showAppsIcon object is encaptulated, and a reference to it will be properly wired upon
 * use of this class in place of the original showAppsButton.
 *
 */
export const ShowAppsIconWrapper = class extends EventEmitter {
  constructor(dtpPanel) {
    super();

    this.realShowAppsIcon = new Dash.ShowAppsIcon();

    /* the variable equivalent to toggleButton has a different name in the appIcon class
        (actor): duplicate reference to easily reuse appIcon methods */
    this.actor = this.realShowAppsIcon.toggleButton;
    this.realShowAppsIcon.show(false);

    // Re-use appIcon methods
    this._removeMenuTimeout = AppDisplay.AppIcon.prototype._removeMenuTimeout;
    this._setPopupTimeout = AppDisplay.AppIcon.prototype._setPopupTimeout;
    this._onKeyboardPopupMenu =
      AppDisplay.AppIcon.prototype._onKeyboardPopupMenu;

    // No action on clicked (showing of the appsview is controlled elsewhere)
    this._onClicked = () => this._removeMenuTimeout();

    // constructor içinde
    this.actor.set_pivot_point(0.5, 0.5); // Ortadan küçülme için
    this.actor.connect("notify::hover", () => {
      this.setShowAppsBoxShadow(this.actor.hover);
    });
    this.actor.connect("leave-event", this._onLeaveEvent.bind(this));
    this.actor.connect("button-press-event", this._onButtonPress.bind(this));
    this.actor.connect("touch-event", this._onTouchEvent.bind(this));
    this.actor.connect("clicked", this._onClicked.bind(this));
    this.actor.connect("popup-menu", this._onKeyboardPopupMenu.bind(this));
    this.actor.connect("notify::pressed", () => {
      // Sadece ikon küçülsün
      let iconBin = this.realShowAppsIcon.icon._iconBin;
      if (!iconBin) return;

      iconBin.set_pivot_point(0.5, 0.5);

      if (this.actor.pressed) {
        Utils.stopAnimations(iconBin);
        iconBin.set_scale(1, 1);
        Utils.animate(iconBin, {
          scale_x: 0.9,
          scale_y: 0.9,
          time: 0.1,
          transition: "easeOutQuad",
        });
      } else {
        Utils.animate(iconBin, {
          scale_x: 1,
          scale_y: 1,
          time: 0.13,
          transition: "easeOutBack",
        });
      }
    });
    this._menu = null;
    this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
    this._menuTimeoutId = 0;
    this.realShowAppsIcon._dtpPanel = dtpPanel;
    Taskbar.extendDashItemContainer(this.realShowAppsIcon);
    let customIconPath = SETTINGS.get_string("show-apps-icon-file");
    this.realShowAppsIcon.icon.createIcon = function () {
      this._iconActor = new St.Icon({
        icon_name: "view-app-grid-symbolic",
        icon_size: 31,
        style_class: "show-apps-icon",
        track_hover: true,
      });
      if (customIconPath) {
        this._iconActor.gicon = new Gio.FileIcon({
          file: Gio.File.new_for_path(customIconPath),
        });
      }
      return this._iconActor;
    };
    this._changedShowAppsIconId = SETTINGS.connect(
      "changed::show-apps-icon-file",
      () => {
        customIconPath = SETTINGS.get_string("show-apps-icon-file");
        this.realShowAppsIcon.icon._createIconTexture(
          this.realShowAppsIcon.icon.iconSize
        );
      }
    );
    this._changedAppIconPaddingId = SETTINGS.connect(
      "changed::appicon-padding",
      () => this.setShowAppsPadding()
    );
    this._changedAppIconSidePaddingId = SETTINGS.connect(
      "changed::show-apps-icon-side-padding",
      () => this.setShowAppsPadding()
    );
    this.setShowAppsPadding();
  }
  setShowAppsBoxShadow(enable) {
    if (enable) {
      this.actor.set_style(
        "box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06) inset;"
      );
    } else {
      this.actor.set_style("box-shadow: none;");
    }
  }
  _onButtonPress(_actor, event) {
    let button = event.get_button();
    if (button == 1) {
      this._setPopupTimeout();
    } else if (button == 3) {
      this.popupMenu();
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  }
  _onLeaveEvent() {
    this.actor.fake_release();
    this._removeMenuTimeout();
  }
  _onTouchEvent(actor, event) {
    if (event.type() == Clutter.EventType.TOUCH_BEGIN) this._setPopupTimeout();
    return Clutter.EVENT_PROPAGATE;
  }
  _onMenuPoppedDown() {
    this._menu.sourceActor = this.actor;
    this.actor.sync_hover();
    this.emit("menu-state-changed", false);
  }
  setShowAppsPadding() { }
  createMenu() {
    if (!this._menu) {
      this._menu = new MyShowAppsIconMenu(
        this.realShowAppsIcon,
        this.realShowAppsIcon._dtpPanel
      );
      this._menu.connect("open-state-changed", (menu, isPoppedUp) => {
        if (!isPoppedUp) this._onMenuPoppedDown();
      });
      let id = Main.overview.connect("hiding", () => {
        this._menu.close();
      });
      this._menu.actor.connect("destroy", () => {
        Main.overview.disconnect(id);
      });
      // We want to keep the item hovered while the menu is up
      this._menu.blockSourceEvents = true;
      Main.uiGroup.add_child(this._menu.actor);
      this._menuManager.addMenu(this._menu);
    }
  }
  popupMenu(sourceActor = null) {
    this._removeMenuTimeout();
    this.actor.fake_release();
    this.createMenu();
    this._menu.updateItems(
      sourceActor == null ? this.realShowAppsIcon : sourceActor
    );
    this.actor.set_hover(true);
    this._menu.open(BoxPointer.PopupAnimation.FULL);
    this._menuManager.ignoreRelease();
    this.emit("sync-tooltip");
    return false;
  }
  shouldShowTooltip() {
    return (
      SETTINGS.get_boolean("show-tooltip") &&
      this.actor.hover &&
      (!this._menu || !this._menu.isOpen)
    );
  }
  destroy() {
    SETTINGS.disconnect(this._changedShowAppsIconId);
    SETTINGS.disconnect(this._changedAppIconSidePaddingId);
    SETTINGS.disconnect(this._changedAppIconPaddingId);
    this.realShowAppsIcon.destroy();
  }
};

/**
 * A menu for the showAppsIcon
 */
export const MyShowAppsIconMenu = class extends PopupMenu.PopupMenu {
  constructor(actor, dtpPanel) {
    super(actor, 0, dtpPanel.geom.position);
    this._dtpPanel = dtpPanel;
    this.updateItems(actor);
  }
  updateItems(sourceActor) {
    this.sourceActor = sourceActor;
    this.removeAll();
    if (this.sourceActor != Main.layoutManager.dummyCursor) {
      this._appendItem({
        title: _("Event logs"),
        cmd: ["gnome-logs"],
      });
      this._appendItem({
        title: _("Device management"),
        cmd: ["gnome-control-center", "display"],
      });
      this._appendItem({
        title: _("Disk management"),
        cmd: ["gnome-disks"],
      });
      this._appendList(
        SETTINGS.get_strv("show-apps-button-context-menu-commands"),
        SETTINGS.get_strv("show-apps-button-context-menu-titles")
      );
      this._appendSeparator();
    }
    JSON.parse(SETTINGS.get_string("context-menu-entries")).forEach((e) => {
      if (e.cmd == "TERMINALSETTINGS")
        e.cmd = TERMINALSETTINGS.get_string("exec");

      this._appendItem({
        title: e.title,
        cmd: e.cmd.split(" "),
      });
    });
    this._appendList(
      SETTINGS.get_strv("panel-context-menu-commands"),
      SETTINGS.get_strv("panel-context-menu-titles")
    );
    this._appendItem({
      title: _("Settings"),
      cmd: ["gnome-control-center"],
    });
    this._appendSeparator();
    let lockTaskbarMenuItem = this._appendMenuItem(
      SETTINGS.get_boolean("taskbar-locked")
        ? _("Unlock taskbar")
        : _("Lock taskbar")
    );
    lockTaskbarMenuItem.connect("activate", () => {
      SETTINGS.set_boolean(
        "taskbar-locked",
        !SETTINGS.get_boolean("taskbar-locked")
      );
    });
  }
  _appendItem(info) {
    if (GLib.find_program_in_path(info.cmd[0])) {
      let item = this._appendMenuItem(_(info.title));
      item.connect("activate", function () {
        Util.spawn(info.cmd);
      });
      return item;
    }
    return null;
  }
  _appendList(commandList, titleList) {
    if (commandList.length != titleList.length) {
      return;
    }
    for (let entry = 0; entry < commandList.length; entry++) {
      this._appendItem({
        title: titleList[entry],
        cmd: commandList[entry].split(" "),
      });
    }
  }
  _appendSeparator() {
    let separator = new PopupMenu.PopupSeparatorMenuItem();
    this.addMenuItem(separator);
  }
  _appendMenuItem(labelText) {
    let item = new PopupMenu.PopupMenuItem(labelText);
    item.add_style_class_name("app-well-menu-item");
    this.addMenuItem(item);
    return item;
  }
};
export const getIconContainerStyle = function () {
  let style = "padding: ";
  if (SETTINGS.get_boolean("group-apps")) {
    style += "0 " + DEFAULT_PADDING_SIZE + "px;";
  } else {
    style += "0 " + DEFAULT_PADDING_SIZE + "px;";
  }
  return style;
};
