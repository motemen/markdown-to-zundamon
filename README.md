# markdown-to-zundamon

Markdown を書くだけで、ずんだもんが解説してくれる動画を自動生成するツール。

[Remotion](https://www.remotion.dev/) + [VOICEVOX](https://voicevox.hiroshiba.jp/) ベース。

## 仕組み

Markdown の記法がそのまま動画の構成になります:

- **引用（blockquote）** → スライドとして画面に表示
- **それ以外のテキスト** → ずんだもんのセリフ（VOICEVOX で音声合成）
- **`[pause: 500ms]`** → 指定時間の間（ポーズ）

```markdown
> # タイトルスライド

こんにちは！ ずんだもんなのだ。

> - ポイント1
> - ポイント2

ここを説明するよ！
[pause: 500ms]
次のセリフなのだ。

> ![](./image.png)
```

## クイックスタート

### 前提条件

- Node.js (v18+)
- [VOICEVOX](https://voicevox.hiroshiba.jp/) が起動していること（デフォルト: `http://localhost:50021`）

### セットアップ

```bash
# リポジトリを取得
git clone https://github.com/motemen/markdown-to-zundamon.git
# または
npx degit motemen/markdown-to-zundamon markdown-to-zundamon

cd markdown-to-zundamon
npm install
```

## 使い方

### 1. 前処理（音声生成）

```bash
npm run preprocess -- <markdownファイル>
```

Markdown を解析し、VOICEVOX で音声を生成して `public/projects/<プロジェクト名>/` 以下にマニフェストと音声ファイルを出力します。プロジェクト名は Markdown ファイル名（拡張子なし）から自動決定されます。

### 2. プレビュー

```bash
npm run studio -- <プロジェクト名>
```

Remotion Studio でブラウザ上のプレビューを確認できます。

### 3. 動画レンダリング

```bash
npm run render -- <プロジェクト名>
```

`out/<プロジェクト名>.mp4` に動画が出力されます。

### 実行例

```bash
npm run preprocess -- slides/my-talk.md
npm run studio -- my-talk       # プレビュー
npm run render -- my-talk       # out/my-talk.mp4
```

## 環境変数

| 変数名 | デフォルト値 | 説明 |
|--------|-------------|------|
| `VOICEVOX_BASE` | `http://localhost:50021` | VOICEVOX API のベース URL |

例: リモートの VOICEVOX サーバーを使う場合:

```bash
VOICEVOX_BASE=http://192.168.1.100:50021 npm run preprocess -- slides/my-talk.md
```

## Frontmatter 設定

Markdown ファイルの先頭に YAML frontmatter で動画の設定を記述できます。`characters` は必須で、それ以外は省略可能です。

```yaml
---
fps: 30                          # フレームレート（デフォルト: 30）
width: 1920                      # 動画の幅（デフォルト: 1920）
height: 1080                     # 動画の高さ（デフォルト: 1080）
speakerId: 3                     # VOICEVOX の話者ID（デフォルト: 3=ずんだもん ノーマル）
slideTransitionMs: 600           # スライド切り替え時の間（ミリ秒）
speechGapMs: 200                 # セリフ間の間隔（ミリ秒）
paragraphGapMs: 400              # 段落間の間隔（ミリ秒）
fontFamily: "M PLUS Rounded 1c"  # 基本フォント
subtitleFontFamily: ""           # 字幕用フォント（省略時は fontFamily）
slideFontFamily: ""              # スライド用フォント（省略時は fontFamily）
characters:
  ... # 以下を参照
---
```

### キャラクター設定

`characters` でキャラクターを定義します（必須、1人以上）。セリフ中に `[キャラ名]` タグで話者を切り替えられます。

```yaml
---
characters:
  - name: ずんだもん
    speakerId: 3
    position: right        # left or right（デフォルト: right、2人目は left）
    color: "#55B02E"       # 字幕の色
    height: 800            # キャラ画像の高さ（px）
    overflowY: 0.4         # 画面下方向のはみ出し割合（デフォルト: 0.4）
    overflowX: 0.1         # 画面横方向のはみ出し割合（デフォルト: 0.1）
  - name: 四国めたん
    speakerId: 2
    position: left
    color: "#D85898"
---

[ずんだもん] こんにちは！ ずんだもんなのだ。
[四国めたん] 四国めたんよ。よろしくね。
話者タグを省略すると、直前の話者が引き継がれるわ。
```

キャラクター画像は `characters/<キャラ名>/default.png` に配置してください。口パクアニメーション用に `default_active1.png`, `default_active2.png` を追加すると、発話中に口が動くようになります。

### BGM 設定

`bgm` で動画にBGMを追加できます。BGM ファイルのパスは Markdown ファイルからの相対パス、またはプロジェクトルートからの相対パスで指定します。

```yaml
---
bgm:
  src: ./bgm/background-music.mp3   # BGM ファイルパス（必須）
  volume: 0.1                        # 音量 0〜1（デフォルト: 0.1）
  fadeInMs: 2000                     # フェードイン時間（ミリ秒、デフォルト: 0）
  fadeOutMs: 3000                    # フェードアウト時間（ミリ秒、デフォルト: 1000）
characters:
  - name: ずんだもん
    speakerId: 3
---
```

`preprocess`時に BGM ファイルが `public/projects/<プロジェクト名>/bgm/` に自動コピーされ、動画全体でループ再生されます。対応形式は mp3, wav, ogg など（HTML5 Audio がサポートするもの）。

## Markdown の書き方

### セリフ

通常のテキストがずんだもんのセリフになります。**1行が1つのセリフ**として処理されます。

```markdown
こんにちは！ ずんだもんなのだ。
今日はいい天気だね。
```

### スライド

引用（`>`）で囲んだ部分がスライドとして表示されます。Markdown の記法（見出し、リスト、太字、画像など）がそのままレンダリングされます。

```markdown
> ## スライドタイトル
>
> - **ポイント1**: 説明
> - ポイント2
>
> ![](./diagram.png)
```

画像はローカルファイル・URL どちらも使えます。

### ポーズ（間）

`[pause: 時間]` で明示的に間を入れられます。

```markdown
ここで一旦止めるよ。
[pause: 1s]
続きなのだ。
```

## レイアウト

```
+----------------------------------------------+
|  +---------------------+                     |
|  |                     |                     |
|  |   スライド内容       |                     |
|  |   (Markdown)        |                     |
|  |                     |                     |
|  +---------------------+          +--------+ |
|                                   |ずんだもん| |
|  +------------------------------+ |        | |
|  |    字幕テキスト（袋文字）      | +--------+ |
|  +------------------------------+             |
+----------------------------------------------+
```

## ファイル構成

```
├── scripts/
│   ├── preprocess.ts    # 前処理（Markdown解析 + VOICEVOX音声生成）
│   ├── studio.ts        # Remotion Studio 起動
│   └── render.ts        # レンダリング
├── src/
│   ├── index.ts         # Remotion registerRoot
│   ├── Root.tsx          # Composition 登録
│   ├── Composition.tsx   # メイン合成コンポーネント
│   ├── components/       # UI コンポーネント群
│   └── types.ts          # 型定義
├── characters/           # キャラクター画像（ソース）
│   ├── ずんだもん/
│   │   ├── default.png
│   │   ├── default_active1.png
│   │   └── default_active2.png
│   └── 四国めたん/
├── public/projects/      # 前処理出力（生成物）
│   └── <project>/
│       ├── manifest.json
│       ├── audio/
│       ├── bgm/
│       └── images/
└── out/                  # レンダリング出力
    └── <project>.mp4
```

## ライセンス

ISC
