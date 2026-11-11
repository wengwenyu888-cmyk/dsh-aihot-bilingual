# 发布清单 / Publishing checklist

> 目标：发布到 npm → GitHub 建仓 → dshfind 自动收录 → 别人在「插件 → 发现」一键安装。
> 本插件**免费、非商业**分发，符合 AIHOT 使用条款（见下「合规」）。

## 第 0 步 · 填两个空

在 `package.json` 和 `LICENSE` 里把占位符换成你自己的：

- `package.json` → `repository.url` 中的 `your-name` → 你的 GitHub 用户名
- `LICENSE` 第一行 `Copyright (c) 2026 <your name>` → 你的名字

## 第 1 步 · 发到 npm（约 2 分钟）

```bat
cd dsh-aihot-bilingual-publish
npm login          :: 浏览器登录你的 npm 账号（没有就先去 npmjs.com 注册）
npm publish        :: 包名 dsh-aihot-bilingual；若重名，改用 @你的用户名/dsh-aihot-bilingual（package.json 的 name 加前缀即可）
```

> 若改用 scoped 包名（`@wengwenyu888-cmyk/dsh-aihot-bilingual`），首次发布要加 `--access public`：
> `npm publish --access public`。发布后核对：https://www.npmjs.com/package/<包名>

发布后核对：https://www.npmjs.com/package/dsh-aihot-bilingual

以后更新：改代码 → 把 `version` 加一（如 1.0.0 → 1.0.1）→ 再 `npm publish`。

## 第 2 步 · 上传 GitHub（约 3 分钟）

网页路径（不需要 git 命令行）：在 GitHub 上 New repository（名字建议 `dsh-aihot-bilingual`，Public），
然后把本目录的所有文件传上去（网页拖拽即可）。

或者命令行路径：

```bat
cd dsh-aihot-bilingual-publish
git init
git add -A
git commit -m "AIHOT bilingual reader plugin v1.0.0"
git remote add origin https://github.com/你的用户名/dsh-aihot-bilingual.git
git branch -M main
git push -u origin main
```

要点：`package.json` 的 `repository.url` 必须和这个仓库一致——dshfind 靠它验证 npm ↔ GitHub 对应。

## 第 3 步 · 等 dshfind 自动收录（≤ 1 天，无需提交）

dshfind 每天抓取 npm 上「repository 指回 GitHub」的新包并评分。收录后：

- 所有配置了 dshfind 索引的用户（含你）会在 **插件 → 发现** 里搜到「AIHOT 双语阅读」，一键安装；
- 收录页地址：`https://dshfind.com/en/plugins/<你的用户名>/dsh-aihot-bilingual`
- 想更快/分类更准，可到 dshfind.com 看是否有认领/分类入口。

## 第 4 步 · 验证安装链路（装完记得卸掉再装回来）

自己用一个干净 profile 或直接在插件页「发现」里搜一下，确认一键安装可用。

## 合规（重要，已替你处理大半）

- 本插件免费、非商业分发 → 符合 AIHOT 使用条款（https://aihot.news/terms），无需事先授权。
- 若日后收费或商用：先邮件 agent@virxact.com 取得 AIHOT 书面授权。
- 已内置：「数据来源 AIHOT」界面署名、60 秒列表节流、README 双语隐私与费用说明、
  LICENSE 里写明 AIHOT 数据不随 MIT 许可分发。

## 提醒（给未来用户的现实说明，README 已写）

- 翻译/点词用的是**用户自己配置的默认模型**，每次未缓存调用消耗其模型额度——请在发布说明里保留这句话。
- 插件注册的 `/api/aihot-bilingual` 路由仅监听本机回环地址，无鉴权；个人使用足够。
