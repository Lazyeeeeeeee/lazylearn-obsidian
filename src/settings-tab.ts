import { PluginSettingTab, Setting, type App } from "obsidian";

import type LazyLearnPlugin from "./main.ts";
import { SUBJECTS, normalizeBaseUrl, scopeFor, scopesFor } from "./settings.ts";

export class LazylearnSettingTab extends PluginSettingTab {
  #plugin: LazyLearnPlugin;

  constructor(app: App, plugin: LazyLearnPlugin) {
    super(app, plugin);
    this.#plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("lazylearn-settings");

    new Setting(containerEl).setName("服务").setHeading();

    new Setting(containerEl)
      .setName("服务地址")
      .setDesc("懒学的网址。改地址等于换一个账号体系：当前会话会被清掉，需要重新登录。")
      .addText((text) => {
        text.setPlaceholder("https://lazylearn.example.com").setValue(this.#plugin.settings.baseUrl);
        // 用 change 而不是 onChange：onChange 每敲一个字就触发一次，改地址会连带清会话。
        text.inputEl.addEventListener("change", () => {
          void this.#plugin.applyBaseUrl(normalizeBaseUrl(text.getValue()));
        });
      });

    new Setting(containerEl)
      .setName("账号")
      .setDesc(this.#plugin.controller.snapshot.account === null ? "未登录" : "已登录")
      .addButton((button) =>
        button.setButtonText("退出登录").onClick(() => {
          void this.#plugin.signOut().then(() => this.display());
        }),
      );

    this.#renderSignIn(containerEl);

    new Setting(containerEl).setName("出题").setHeading();

    new Setting(containerEl)
      .setName("科目")
      .setDesc("首版开放数学与 408 的选择题。已经绑定过的笔记按它自己 frontmatter 里的科目出题，改这里只影响新绑定。")
      .addDropdown((dropdown) => {
        for (const subject of SUBJECTS) dropdown.addOption(subject.id, subject.label);
        dropdown.setValue(this.#plugin.settings.subject).onChange((value) => {
          void this.#plugin
            .applyScope(value, scopeFor(value, this.#plugin.settings.examScope))
            .then(() => this.display());
        });
      });

    new Setting(containerEl).setName("卷种").addDropdown((dropdown) => {
      for (const scope of scopesFor(this.#plugin.settings.subject)) {
        dropdown.addOption(scope.id, scope.label);
      }
      dropdown.setValue(this.#plugin.settings.examScope).onChange((value) => {
        void this.#plugin.applyScope(this.#plugin.settings.subject, value).then(() => this.display());
      });
    });

    new Setting(containerEl)
      .setName("归档目录")
      .setDesc("错题归档写到这里（相对于 vault 根）。")
      .addText((text) => {
        text.setPlaceholder("LazyLearn").setValue(this.#plugin.settings.archiveRoot);
        text.inputEl.addEventListener("change", () => {
          void this.#plugin.applyArchiveRoot(text.getValue());
        });
      });
  }

  /** 密码只用于这一次登录，不进 data.json、不进日志。 */
  #renderSignIn(containerEl: HTMLElement): void {
    let username = "";
    let password = "";
    const setting = new Setting(containerEl).setName("登录").setDesc("用户名与密码直接用懒学账号。");

    setting.addText((text) => {
      text.setPlaceholder("用户名");
      text.onChange((value) => {
        username = value;
      });
    });
    setting.addText((text) => {
      text.setPlaceholder("密码");
      text.inputEl.type = "password";
      text.onChange((value) => {
        password = value;
      });
    });
    setting.addButton((button) =>
      button
        .setButtonText(this.#plugin.controller.snapshot.phase === "loading" ? "登录中…" : "登录")
        .setCta()
        .onClick(() => {
          void this.#plugin.controller.signIn(username, password).then(() => this.display());
        }),
    );

    const message = this.#plugin.controller.snapshot.message;
    if (message !== null) {
      containerEl.createEl("p", { text: message, cls: "lazylearn-settings-message" });
    }
  }
}
