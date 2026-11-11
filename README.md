# dsh-aihot-bilingual · AIHOT 双语阅读

A DeepSeek Harness plugin that turns AIHOT (https://aihot.news) into an English-learning reader: a sidebar panel with a bilingual article view, in-context word lookup, a vocabulary notebook, and local caching.

一个 DeepSeek Harness 插件：把 AIHOT（https://aihot.news）变成英语学习阅读器。侧栏面板，双语对照、点词释义、生词本、本地缓存。

[English](#english) · [中文](#中文)

## English

### Features

- **News list** — AIHOT's curated feed (last 7 days) via the official anonymous JSON API; no API key needed.
- **Bilingual article view** — English text in large type (18px) with the Chinese reference in small gray type (13px), paragraph by paragraph. English is the primary reading text.
- **English original first** — when the item links to an English source, the article is fetched and extracted; otherwise the AIHOT Chinese text is translated to English. Either way, English and Chinese paragraphs map one-to-one, in order.
- **Whole-article contextual translation** — title and body are translated in one pass by the harness's own default model (no extra API key; each uncached translation consumes one model call). Natural phrasing, proper nouns kept in English.
- **Word lookup** — click any English word: a popover shows the word's meaning **in that sentence**, part of speech, IPA, and a speak button.
- **Vocabulary notebook** — save clicked words, review them in a tab, delete/clear/export as CSV.
- **Caching** — the news list (60 s throttle), bilingual documents, and word lookups are cached locally; reopening a read article is instant. "重新翻译" forces a refresh.

### Install

1. From npm (after publishing): install the bundle into your Harness profile, e.g. via a plugin index that lists this package, or by adding it to your profile's `cordis.patch.yml` as an insert row.
2. From source: copy this directory into your workspace and run Plugin Manager's install with the package directory.

Requirements: DeepSeek Harness ≥ 0.2.0 with a configured default model (translation uses it).

### Privacy & cost

- Clicked words and article text are sent to the model configured in your Harness for translation/lookup.
- News data is fetched anonymously from AIHOT. "数据来源 AIHOT" attribution is kept in the UI.

### Third-party data

AIHOT's data is not covered by this package's MIT license. AIHOT's public usage rules (https://aihot.news/terms) apply: personal non-commercial use is free; external commercial use requires prior written authorization from AIHOT (agent@virxact.com).

## 中文

### 功能

- **资讯列表**：AIHOT 精选（最近 7 天），官方匿名 JSON 接口，无需任何 Key。
- **双语详情**：英文 18px 大字为主、中文 13px 灰色小字对照，逐段一一对应；优先抓条目自带的英文原文，抓不到时把 AIHOT 中文翻成英文。
- **整篇上下文翻译**：标题+全文一次交给 Harness 的默认模型翻译（无需额外 API Key；每次未缓存的翻译消耗一次模型调用），拒绝直译腔，专有名词保留英文。
- **点词翻译**：单击英文单词，弹出「本句含义 + 词性 + 音标 + 朗读」。
- **生词本**：收藏点过的词，按时间复习，可导出 CSV。
- **缓存**：列表 60 秒节流；文章双语内容与点词记录本地缓存，重开秒显；「重新翻译」强制刷新。

### 安装

通过插件索引 / npm 安装，或把本目录交给插件管理器安装。要求 DeepSeek Harness ≥ 0.2.0，并已在设置里配置默认模型。

### 隐私与费用

- 点过的单词与文章正文会发送给你在 Harness 中配置的模型。
- 资讯数据匿名取自 AIHOT，界面保留「数据来源 AIHOT」署名。

### 第三方数据

AIHOT 的数据不在本包 MIT 许可范围内，适用 AIHOT 公开使用规则（https://aihot.news/terms）：个人非商业使用免费；面向外部的商业用途须事先取得 AIHOT 书面授权（agent@virxact.com）。

## License / 许可

Code: MIT (see [LICENSE](LICENSE)). AIHOT data: subject to AIHOT's own terms.
