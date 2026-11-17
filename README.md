# 日記

Mac をはじめ、Windows・Linux・Android・iPhone のネイティブアプリとして動く日記アプリ。

**いまの既定は、同期なしのオフライン版。** 日記はその端末の中（SQLite のファイル1つ）だけに保存され、
外へは何も送られない。アカウントも設定も要らず、入れたらすぐ書ける。
端末の間で内容を揃える同期の機能も作ってあり、ビルド時の切り替えで有効にできる（後述）。

- 日記は端末の中に保存される。電波が無くても書ける。
- 日記の日時は3つに分かれている。**日付**は自分で明示的に付けるもの（付けなくてもよい）、
  **作成**と**最終更新**は自動で入るもの。一覧は日付の順に並び、日付を付けていない日記は作成した日の位置に並ぶ。
  最終更新は、本文だけでなく構造・タグ・写真を変えたときにも進む。
- 日記ごとに**ロック**できる。ロック中は日付・題・本文・構造・タグ・写真のどれも変えられず、ゴミ箱にも入れられない。
  ロックの付け外しそのものは、最終更新を動かさない。
- 消した日記は**ゴミ箱**に入り、30日の間は元に戻せる。30日を過ぎると自動で完全に削除される。
  ゴミ箱への出し入れも、最終更新を動かさない。
- 日記には**タグ**と**写真**を付けられ、本文・構造の中身・タグ名で**検索**できる。
- 日記には**構造**（項目のまとまり。例: 「体調」= 睡眠時間・気分）を自由に付け外しできる。
  - 構造ごとにタグを付けられる。
  - 構造は**テンプレ**として保存でき、別の日記に付け直せる。テンプレにもタグを持たせられる。
  - タグ同士には**親子**と**関連**の関係を持たせられる。親タグで絞ると子孫のタグが付いたものも出る。関連タグは付けるときの候補に出る。

## しくみ

```
src/            画面とデータの扱い（TypeScript + React）。全端末で共通。
  db/           端末内SQLiteのスキーマと操作（repo.ts が窓口）
  sync/         同期。engine.ts が手順、supabase.ts が同期先とのやりとり
  ui/           画面
src-tauri/      ネイティブアプリの殻（Tauri 2 / Rust）。窓を開き、SQLiteを画面側へ貸すだけ。
supabase/       同期先に1回だけ流すSQL
tests/          データ操作と同期のテスト
```

同期の考え方は単純で、どの行も `updated_at`（最後に変えた時刻）を持ち、**行ごとに新しい方を採用**する。
削除は行を消さずに「削除済み」の印を付けて伝える。同じ日記を2台で同時に編集した場合は、後から編集した方が残る
（文章を混ぜ合わせることはしない）。

## Mac で使い始める（オフライン版）

1. GitHub の Actions →「アプリをビルド」の最新の実行を開き、ページ下部の Artifacts から **nikki-Mac** を落とす。
2. zip を開き、中の `.dmg` を開いて、Nikki をアプリケーションフォルダへ移す。
3. 初回は「開発元を確認できない」という警告が出る（Apple に登録していないため）。
   システム設定 → プライバシーとセキュリティ の下の方にある「このまま開く」を押す。
   「壊れているため開けません」と出る場合は、ターミナルで次を実行してから開く。

   ```sh
   xattr -cr /Applications/Nikki.app
   ```

日記は `~/Library/Application Support/dev.nikki.diary/diary.db` に保存される（アプリの「設定」にも表示される）。
このファイル1つに日記・構造・タグ・写真がすべて入っているので、控えはこのファイルをコピーすれば取れる。
Time Machine を使っていれば自動で控えられる。アプリを新しい版に入れ替えても、このファイルはそのまま使われる。

## 同期を使う場合

端末の間で内容を揃えたくなったら、次の2つを行う。同期つきの版では、同じアカウントでログインした端末の間で内容が揃う。
同期先は自分の Supabase プロジェクト。

- リポジトリの Settings → Secrets and variables → Actions → **Variables** に `SYNC` = `on` を登録してビルドし直す
  （手元でビルドする場合は `VITE_SYNC=on npm run tauri build`）。
- 下の手順で同期先を用意する。

オフライン版で書きためた日記は、同期つきの版に入れ替えてログインすれば、そのまま同期先へ送られる。

### 同期先（Supabase）を用意する

1. <https://supabase.com> でプロジェクトを作る（無料枠で足りる）。
2. SQL Editor に [`supabase/schema.sql`](supabase/schema.sql) の中身を貼って実行する。
3. Authentication → Users → Add user で、自分のメールアドレスとパスワードのユーザーを作る
   （「Auto Confirm User」にチェック）。アプリ内の「はじめて使う（登録）」からでも作れるが、
   その場合は確認メールのリンクを開く必要がある。
4. 自分以外に登録させないため、Authentication → Sign In / Providers で「Allow new users to sign up」を切っておく。
5. Project Settings → API にある **Project URL** と **anon（publishable）key** を控える。

アプリの「設定」でこの2つを入れてログインすれば同期が始まる。
毎回入力したくない場合は、GitHub のリポジトリの Settings → Secrets and variables → Actions → **Variables** に
`SUPABASE_URL` と `SUPABASE_ANON_KEY` を登録しておくと、ビルドしたアプリに埋め込まれる
（anon key は公開されてよい鍵で、自分の行しか読み書きできない設定になっている）。

#### Supabaseを止めないために

Supabase の無料プロジェクトは、しばらく使われないと一時停止される。日記を書かない日が続いても止まらないよう、
GitHub Actions（[`keepalive.yml`](.github/workflows/keepalive.yml)）が毎日1回データベースに問い合わせる。
上の `SUPABASE_URL` と `SUPABASE_ANON_KEY` を Variables に登録すると働き始める（未登録の間は何もしない）。
Actions の「Supabaseを起こしておく」→ Run workflow で、すぐに1回試せる。

- 応答が無かった日は実行が失敗になり、GitHub からメールが届く。
- GitHub 側にも決まりがあり、リポジトリに60日間何も動きが無いと、定期実行が自動で止められる。
  その場合は Actions の画面に出る案内から有効に戻す。

## 他の端末向けのアプリ

このリポジトリに変更を push すると、GitHub Actions が全端末向けをビルドする。
Actions のその実行のページ下部「Artifacts」から落とせる。`v0.1.0` のようなタグを付けると、Releases にも置かれる。

| 端末 | ファイル | 入れ方 |
| --- | --- | --- |
| Windows | `.exe` | 実行する。署名が無いので警告が出たら「詳細情報 → 実行」。 |
| Mac | `.dmg` | 上の「Mac で使い始める」のとおり。 |
| Linux | `.deb` / `.AppImage` | そのまま入れる／実行権限を付けて実行する。 |
| Android | `nikki.apk` | スマホで開いて入れる（提供元不明のアプリを許可）。 |
| iPhone | `nikki.ipa` | 署名が付いていないので、SideStore や AltStore に読み込ませて自分の Apple ID で署名して入れる。 |

### Androidの署名の鍵

Android は、前と同じ鍵で署名されたものでないと上書きインストールできない。次の手順で鍵を1度作って登録しておく
（登録しない場合は毎回その場限りの鍵になり、入れ直しになる。同期していれば日記は戻る）。

```sh
keytool -genkeypair -keystore release.jks -alias nikki -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Nikki"
base64 -w0 release.jks   # Macは base64 -i release.jks
```

出てきた文字列を `ANDROID_KEYSTORE_BASE64`、決めたパスワードを `ANDROID_KEYSTORE_PASSWORD` として、
Settings → Secrets and variables → Actions → **Secrets** に登録する。`release.jks` は無くさないよう保管する。

## 開発

```sh
npm install
npm run dev          # ブラウザで動かす（データはブラウザ内に保存される）
npm test             # データ操作と同期のテスト
npm run tauri dev    # ネイティブアプリとして動かす（Rustが必要）
npm run tauri build  # いま使っているOS向けのアプリを作る
```

どれも既定ではオフライン版になる。同期つきで動かすときは、先頭に `VITE_SYNC=on` を付ける。

## まだ無いもの

- 日記の書き出し（バックアップ用のファイル出力）
- アプリを開くときのパスコード、端末間の暗号化
- 2台で同時に同じ日記を書いたときの、文章の混ぜ合わせ（後から編集した方が残る）
