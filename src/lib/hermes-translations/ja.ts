/**
 * Japanese (日本語) — TASK-458.
 *
 * Register follows the shipped ClawBox copy (desktop-translations-part2 `ja`,
 * translations.ts `ja`, clawkeep-translations `ja`): whole sentences use the
 * polite です／ます form and address the user with ～してください, while buttons
 * and column labels stay in the terse noun / dictionary-form style the app
 * already uses ("保存", "再試行", "戻る", "キャンセル"). aria-label and sr-only
 * strings are written as full spoken phrases ("現在のパスワードを表示する").
 *
 * Terminology reused from the shipped catalogues:
 *   Settings 設定 · Save 保存 · Saving… 保存中… · Cancel キャンセル ·
 *   Retry 再試行 · Back 戻る · Continue 次へ · Provider プロバイダー ·
 *   Model モデル · Skill スキル · Agent エージェント · Install インストール ·
 *   Installed インストール済み · Not installed 未インストール ·
 *   Password パスワード · Sign in ログイン · Connected 接続済み ·
 *   device デバイス, "the box" 本体, Sort 並べ替え, Search 検索.
 *
 * Typography: English “…” quotes become Japanese 「…」; the ellipsis …, the
 * three-dot "..." where English used it, the em dash — , the en dash – and the
 * arrow → are all kept exactly as the English has them. Latin words are spaced
 * from surrounding kana as the existing ja copy does ("ローカル AI").
 */
export const ja: Record<string, string> = {
  // === Sidebar sections that had no key at all ===
  "settings.localAi": "ローカル AI",
  "settings.localModels": "ローカルモデル",
  "settings.voice": "音声",

  // === System password card ===
  "settings.security.passwordLabel": "パスワード",
  "settings.security.passwordHintPrefix": "ウェブへのログイン、SSH、および",
  "settings.security.passwordHintSuffix": " に使用します。ここで変更すると、3つすべてに反映されます。",
  "settings.security.currentPassword": "現在のパスワード",
  "settings.security.newPassword": "新しいパスワード",
  "settings.security.newPasswordPlaceholder": "新しいパスワード（8文字以上）",
  "settings.security.confirmNewPassword": "新しいパスワードの確認",
  "settings.security.hideCurrentPassword": "現在のパスワードを非表示にする",
  "settings.security.showCurrentPassword": "現在のパスワードを表示する",
  "settings.security.hideNewPassword": "新しいパスワードを非表示にする",
  "settings.security.showNewPassword": "新しいパスワードを表示する",
  "settings.security.hideConfirmPassword": "確認用パスワードを非表示にする",
  "settings.security.showConfirmPassword": "確認用パスワードを表示する",
  "settings.security.clearAndReenter": "現在のパスワードを消して入力し直す",
  "settings.security.reenter": "再入力",
  "settings.security.checking": "確認中…",
  "settings.security.verify": "確認",
  "settings.security.passwordsDontMatchYet": "パスワードがまだ一致していません",
  "settings.security.saving": "保存中…",
  "settings.security.updatePassword": "パスワードを変更",

  // === "Write this password down" confirmation dialog ===
  "settings.security.confirmTitle": "このパスワードを控えてください",
  "settings.security.confirmBodyPrefix": "これにより",
  "settings.security.confirmBodyScope": "ウェブへのログイン、SSH、sudo",
  "settings.security.confirmBodySuffix": " のパスワードが変更されます。忘れてしまうと、デバイスに一切アクセスできなくなり、復旧には工場出荷時リセットが必要になる場合があります。",
  "settings.security.hidePassword": "パスワードを非表示にする",
  "settings.security.revealPassword": "パスワードを表示する",
  "settings.security.hide": "非表示",
  "settings.security.reveal": "表示",
  "settings.security.confirmChange": "控えました — 変更する",

  // === Validation and status ===
  "settings.security.errorTooShort": "新しいパスワードは8文字以上にしてください",
  "settings.security.errorMismatch": "新しいパスワードが一致しません",
  "settings.security.errorSameAsCurrent": "新しいパスワードは現在のパスワードと違うものにしてください",
  "settings.security.errorInvalidChars": "パスワードに使用できない文字が含まれています",
  "settings.security.verificationFailed": "確認に失敗しました",
  "settings.security.updateSuccess": "パスワードを変更しました。次回のログインや SSH では新しいパスワードを使用してください。",
  "settings.security.failed": "失敗しました",

  // === Saved Wi-Fi password editor ===
  "settings.security.wifiPasswordLength": "パスワードは8–63文字にしてください",
  "settings.security.wifiPasswordUpdated": "{ssid} のパスワードを変更しました",

  // === Panel chrome ===
  "hermesProvider.title": "Hermes のモデル",
  "hermesProvider.intro":
    "このデバイスは Hermes で動作しています。推論プロバイダーと既定のモデルを選んでください — 切り替えは Hermes 側で行われ、ダッシュボードは必要ありません。",
  "hermesProvider.radioGroupLabel": "AI プロバイダー",
  "hermesProvider.continue": "次へ",

  // === Provider rows ===
  "hermesProvider.row.desc.openrouter": "API キー 1 つで 300 以上のモデル",
  "hermesProvider.row.desc.anthropic": "Claude — ログインまたは API キー",
  "hermesProvider.row.desc.openaiCodex": "OpenAI (Codex) でログイン",
  "hermesProvider.row.desc.gemini": "Gemini モデルに直接接続",
  "hermesProvider.row.desc.zai": "Zhipu の GLM モデル",
  "hermesProvider.row.desc.kimiCoding": "Moonshot Kimi（コーディング向け）",
  "hermesProvider.row.desc.copilot": "GitHub でログイン",
  "hermesProvider.row.desc.nous": "Nous でログイン",

  // === ClawBox AI card ===
  "hermesProvider.clawai.activeBadge": "使用中",
  "hermesProvider.clawai.switching": "切り替え中…",
  "hermesProvider.clawai.switchTo": "{tier} に切り替える",
  "hermesProvider.clawai.inUse": "ClawBox AI を使用中",
  "hermesProvider.clawai.modelLabel": "モデル:",
  "hermesProvider.clawai.finishingSetup": "このデバイスでセットアップを完了しています…",
  "hermesProvider.clawai.nowActive": "ClawBox AI が現在のモデルになりました",
  "hermesProvider.clawai.switchFailed": "ClawBox AI に切り替えられませんでした",

  // === Provider sign-in (Hermes-native OAuth) ===
  "hermesProvider.oauth.signInWith": "{provider} でログイン",
  "hermesProvider.oauth.connectedDesc": "接続済みです。OAuth の認証情報が有効です。",
  "hermesProvider.oauth.cliOnlyDesc": "このプロバイダーへは Hermes CLI からログインします。",
  "hermesProvider.oauth.availableDesc": "Hermes 経由の OAuth（API キーは不要）。",
  "hermesProvider.oauth.connectedBadge": "接続済み",
  "hermesProvider.oauth.signIn": "ログイン",
  "hermesProvider.oauth.tryAgain": "再試行",
  "hermesProvider.oauth.cliInstructions": "デバイスのターミナルで次を実行し、このパネルを開き直してください:",
  "hermesProvider.oauth.starting": "{provider} でのログインを開始しています...",
  "hermesProvider.oauth.pkceInstructions":
    "{provider} のログインタブが開きました。そこでアクセスを承認し、表示されたコードをコピーしてここに貼り付けてください。",
  "hermesProvider.oauth.reopenSignInPage": "ログインページを開き直す",
  "hermesProvider.oauth.codeLabel": "{provider} のコードを貼り付けてください",
  "hermesProvider.oauth.submitting": "送信中...",
  "hermesProvider.oauth.submitCode": "コードを送信",
  "hermesProvider.oauth.startOver": "最初からやり直す",
  "hermesProvider.oauth.deviceInstructions":
    "{provider} の確認ページでこのコードを入力してください。承認すると、このパネルは自動的に更新されます。",
  "hermesProvider.oauth.copyCode": "コードをコピー",
  "hermesProvider.oauth.copied": "コピーしました",
  "hermesProvider.oauth.openVerificationPage": "確認ページを開く",
  "hermesProvider.oauth.waitingApproval": "承認を待っています...",
  "hermesProvider.oauth.orPasteKey": "…または、代わりに下へ API キーを貼り付けてください。",
  "hermesProvider.oauth.advancedLabel": "詳細:",
  "hermesProvider.oauth.dashboardLink": "Hermes ダッシュボード（LAN のみ）",

  // === Provider sign-in failures raised by this panel ===
  "hermesProvider.oauth.unexpectedResponse": "Hermes から予期しない応答がありました",
  "hermesProvider.oauth.startFailed": "ログインを開始できませんでした",
  "hermesProvider.oauth.codeRejected": "コードは受け付けられませんでした",
  "hermesProvider.oauth.expired": "ログイン要求の有効期限が切れました。もう一度お試しください。",
  "hermesProvider.oauth.failed": "ログインに失敗しました。もう一度お試しください。",

  // === Model picker ===
  "hermesProvider.model.label": "既定のモデル",
  "hermesProvider.model.loading": "読み込み中…",
  "hermesProvider.model.noCredentials": "このプロバイダーの認証情報はまだありません",
  "hermesProvider.model.noModels": "利用できるモデルがありません",
  "hermesProvider.model.savedElsewherePrefix": "このデバイスは現在",
  "hermesProvider.model.savedElsewhereSuffix": " を使用しています。保存すると {provider} に切り替わります。",
  "hermesProvider.model.staleColdStart": "Hermes はまだモデル一覧を公開していません — 最小限の代替一覧を表示しています。",
  "hermesProvider.model.staleCached": "キャッシュされたモデル一覧を表示しています。Hermes の最新カタログには接続できません。",

  // === API key + save ===
  "hermesProvider.key.label": "{provider} の API キー",
  "hermesProvider.key.placeholder": "API キーを貼り付け（設定済みの場合は省略可）",
  "hermesProvider.save.button": "モデルとプロバイダーを保存",
  "hermesProvider.save.saving": "保存中…",
  "hermesProvider.save.ok": "保存しました",
  "hermesProvider.save.keySavedOk": "キーを保存しました — プロバイダーとモデルを更新しました",
  "hermesProvider.save.failed": "保存に失敗しました",
  "hermesProvider.save.keySavedNoCatalog":
    "{provider} のキーを保存しましたが、モデル一覧がまだ公開されていません — 少し待ってからこのパネルを開き直し、モデルを選んでください。",
  "hermesProvider.save.noCredentials": "{provider} の認証情報はまだありません — 先にログインするか、API キーを貼り付けてください。",
  "hermesProvider.save.catalogUnavailable":
    "Hermes のモデル一覧に現在アクセスできないため、{provider} のモデルを確認できません。少し待ってからもう一度お試しください。",

  // === Header ===
  "skills.title": "Hermes スキル",
  "skills.subtitleWithCount": "Hermes エージェントで使えるスキル {n} 件",
  "skills.subtitleFallback": "Hermes エージェントに機能を追加しましょう",

  // === Tabs ===
  "skills.tablistLabel": "スキルの表示切り替え",
  "skills.tabInstalled.withCount": "インストール済み（{n}）",
  "skills.tabInstalled.empty": "インストール済み",
  "skills.tabBrowse": "探す",

  // === Search and filters ===
  "skills.searchPlaceholder": "スキルを検索…",
  "skills.searchLabel": "スキルを検索",
  "skills.searchBusy": "読み込み中",
  "skills.clearSearch": "検索をクリア",
  "skills.sortLabel": "並べ替え",
  "skills.sortOptions.relevance": "関連度順",
  "skills.sortOptions.name": "名前順 A–Z",
  "skills.sortOptions.trust": "信頼度順",
  "skills.sortOptions.popular": "インストール数順",
  "skills.sourceLabel": "ソース",
  "skills.allSources": "すべてのソース",
  "skills.providerLabel": "公開元",
  "skills.allProviders": "すべての公開元",
  "skills.categoryLabel": "カテゴリ",
  "skills.allCategories": "すべてのカテゴリ",
  "skills.showingRange": "{total} 件中 {from}–{to} 件を表示",
  "skills.degradedCount": "上位 {n} 件の一致 — 検索語を絞り込んでください",
  "skills.loadMore": "さらに読み込む",
  "skills.loadingMore": "スキルをさらに読み込んでいます…",

  // === Scan verdicts ===
  "skills.scanPassed": "スキャンで問題なし",
  "skills.scanFlagged.one": "スキャンで {n} 件の指摘",
  "skills.scanFlagged.other": "スキャンで {n} 件の指摘",
  "skills.notScanned": "未スキャン",

  // === Where a skill came from ===
  "skills.originBuiltin": "組み込み",
  "skills.originHub": "インストール済み",
  "skills.originLocal": "ここで作成",
  "skills.originLocalHelp": "このデバイス上でエージェントが作成したもので、レジストリ由来ではありません。",

  // === Actions ===
  "skills.install": "インストール",
  "skills.installing": "インストール中…",
  "skills.installed": "インストール済み",
  "skills.remove": "削除",
  "skills.removing": "削除中…",
  "skills.retry": "再試行",
  "skills.builtinLocked": "すでに利用可能（組み込み）",
  "skills.cancel": "キャンセル",

  // === Install / remove confirmation ===
  "skills.installTitle": "{name} をインストールしますか？",
  "skills.installTrustedBody": "このスキルは Hermes エージェント内で実行されます。有効にする前に Hermes がスキャンします。",
  "skills.installCommunityBody": "コミュニティ提供のもので、ID Robots の審査は受けていません。下の識別子が想定した公開元のものか確認してください。",
  "skills.installWillAsk": "入力を求められる情報: {labels}",
  "skills.uninstallTitle": "{name} を削除しますか？",
  "skills.uninstallBody.withPath": "エージェントから {path} を削除します。「探す」からいつでも再インストールできます。",
  "skills.uninstallBody.generic": "エージェントからこのスキルを削除します。「探す」からいつでも再インストールできます。",

  // === Mutation status (announced in the store's live region) ===
  "skills.liveInstalling": "{name} をインストールしています",
  "skills.liveInstalled": "{name} をインストールしました",
  "skills.liveInstallFailed": "{name} をインストールできませんでした",
  "skills.installFailed": "インストールに失敗しました",
  "skills.liveRemoving": "{name} を削除しています",
  "skills.liveRemoved": "{name} を削除しました",
  "skills.liveRemoveFailed": "{name} を削除できませんでした",
  "skills.uninstallFailed": "アンインストールに失敗しました",

  // === Empty and error states ===
  "skills.emptySearch": "「{q}」に一致するスキルはありません",
  "skills.emptySearchHint": "別のキーワードでお試しください。",
  "skills.emptySearchAllSources": "代わりにすべてのソースを検索",
  "skills.emptySource": "{label} にはまだ何もありません",
  "skills.clearSourceFilter": "{label} のフィルターを解除",
  "skills.emptyInstalled": "インストール済みのスキルはありません",
  "skills.emptyInstalledHint": "レジストリを見て機能を追加しましょう。",
  "skills.browseSkills": "スキルを探す",
  "skills.installedError": "インストール済みのスキルを読み取れませんでした。",
  "skills.installedStale": "この一覧を更新できませんでした — 最後に確認できた状態を表示しています。",
  "skills.buildingCatalog": "スキルカタログを作成しています — 新しいデバイスでは最初の閲覧に1分ほどかかります。",
  "skills.buildingCatalogAuto": "準備ができ次第、ここにスキルが表示されます — この画面は開いたままで大丈夫です。",
  "skills.catalogStale": "カタログを最後にダウンロードしたのは{when}です。",

  // === Ambiguous identifier ===
  "skills.ambiguousTitle": "「{q}」という名前のスキルが {n} 件あります。使うものを選んでください:",
  "skills.ambiguousPickFirst": "インストールするものを下から選んでください",

  // === Platform compatibility ===
  "skills.platformWarning": "{platforms} が必要です — このスキルは ClawBox では動作しません。",
  "skills.platformOnly": "{platforms} のみ",

  // === Detail sections ===
  "skills.sectionRequirements": "必要なもの",
  "skills.sectionGlance": "概要",
  "skills.sectionAbout": "このスキルについて",
  "skills.sectionSecurity": "セキュリティと出所",
  "skills.sectionRelated": "関連スキル",
  "skills.sectionDocs": "ドキュメント",
  "skills.docsOutline": "このドキュメントの内容",
  "skills.docsSections": "{n} セクション",
  "skills.readMore": "続きを読む",
  "skills.showLess": "折りたたむ",
  "skills.docsFull": "SKILL.md 全文",
  "skills.docsPreview": "ドキュメントのプレビュー — 全文はインストール後に読めます",
  "skills.docsLoading": "ドキュメントを読み込み中…",
  "skills.docsUnavailable": "このスキルにはまだドキュメントがありません。",

  // === Requirements card ===
  "skills.reqCommands": "コマンド",
  "skills.reqCommandPresent": "このデバイスで利用可能",
  "skills.reqCommandMissing": "未インストール",
  "skills.reqEnvVars": "環境変数",
  "skills.reqDependencies": "パッケージ",
  "skills.reqCredentials": "認証情報ファイル",
  "skills.reqCompatibility": "互換性",
  "skills.reqSetup": "セットアップ",
  "skills.reqSecrets": "入力を求められる情報",
  "skills.reqGetKey": "キーを取得",
  "skills.reqSetupGuide": "セットアップガイド",

  // === Provenance card ===
  "skills.provSource": "配布元",
  "skills.provSourceUnverified": "公開元のサイト（未検証）",
  "skills.provRepo": "リポジトリ",
  "skills.provDetailPage": "詳細ページ",
  "skills.provHomepage": "ホームページ",
  "skills.provInstallCommand": "インストールコマンド",
  "skills.provWeeklyInstalls": "インストール数",
  "skills.provContentHash": "コンテンツハッシュ",
  "skills.showAllFindings": "{n} 件の指摘をすべて表示",
  "skills.copyIdentifier": "識別子をコピー",
  "skills.copied": "コピーしました",

  // === "At a glance" fields and card facts ===
  "skills.fieldVersion": "バージョン",
  "skills.fieldAuthor": "作者",
  "skills.fieldLicense": "ライセンス",
  "skills.fieldCategory": "カテゴリ",
  "skills.fieldPlatforms": "プラットフォーム",
  "skills.fieldSize": "サイズ",
  "skills.fieldIncludes": "含まれるもの",
  "skills.fieldInstalled": "インストール日",
  "skills.fieldUpdated": "更新日",
  "skills.fileCount.one": "{n} 個のファイル",
  "skills.fileCount.other": "{n} 個のファイル",
  "skills.installedAgo": "インストール: {when}",

  // === Navigation ===
  "skills.back": "スキル一覧に戻る",
  "skills.breadcrumbLabel": "パンくずリスト",
  "skills.breadcrumbBrowse": "探す",
  "skills.breadcrumbInstalled": "インストール済み",

  // === Relative dates (hub lock timestamps) ===
  "skills.relative.justNow": "たった今",
  "skills.relative.minutes": "{n}分前",
  "skills.relative.hours": "{n}時間前",
  "skills.relative.days.one": "{n}日前",
  "skills.relative.days.other": "{n}日前",
  "skills.relative.months.one": "{n}か月前",
  "skills.relative.months.other": "{n}か月前",
  "skills.relative.years": "{n}年前",

  // === Kind of model ===
  "localModels.kind.llm": "言語",
  "localModels.kind.tts": "音声出力",
  "localModels.kind.stt": "音声入力",
  "localModels.kind.embedding": "メモリ",

  // === Run state ===
  "localModels.run.running": "実行中",
  "localModels.run.idle": "停止中",
  "localModels.run.onDemand": "必要なときに起動",
  "localModels.run.notInstalled": "未インストール",

  // === Panel ===
  "localModels.intro": "本体で動かせるものと、それぞれが今どう動いているかの一覧です。「未インストール」と表示されているものは本当にインストールされていません — ここでオンにできる設定ではありません。",
  "localModels.unavailable": "{list} の状態を読み取れませんでした。",
  "localModels.disk": "ディスク {size}",
  "localModels.memoryInUse": "使用中のメモリ {size}",
  "localModels.managedInClawKeep": "ClawKeep で管理されています。",
  "localModels.managedInLocalAi": "設定 → ローカル AI で管理されています。",
  "localModels.toggleLabel": "{name} を有効にする",
  "localModels.footer": "モデルをオフにすると、すぐに停止し、再起動後もオフのままになります。",

  // === Errors ===
  "localModels.error.changeFailed": "そのモデルを変更できませんでした。",
  "localModels.error.unreachable": "本体に接続できなかったため、そのモデルを変更できませんでした。",

  // === Desktop & power (TASK-455) ===
  "systemProfile.title": "デスクトップと電力",
  "systemProfile.desktopLabel": "デスクトップ環境",
  "systemProfile.desktopHelp": "本体の HDMI 出力とリモートデスクトップで GNOME デスクトップをすべて実行します。オフにするとヘッドレスで動作し、約 700 MB のメモリが戻ります。何もアンインストールされないので、いつでも戻せます。",
  "systemProfile.performanceLabel": "パフォーマンスモード",
  "systemProfile.performanceHelp": "CPU と GPU の周波数を可変にせず最大値に固定します。最初のトークンまでは速くなりますが、待機時の消費電力は約 7.2 W になり、ローカル推論を連続実行したときの実測は 74.8 °C で、パッシブ冷却の上限 74 °C をわずかに超えます。長時間の処理を回し、風通しがある場合を除いてオフのままにしてください。",
  "systemProfile.rebootRequired": "この変更を適用するには本体を再起動してください。",
  "systemProfile.unsupported": "このデバイスでは利用できません。",
  "systemProfile.powerState": "電力プロファイル: {profile} · クロック: {clocks}",
  "systemProfile.clocksPinned": "固定",
  "systemProfile.clocksDynamic": "可変",
  "systemProfile.memoryGuards": "有効なメモリ上限: ローカル AI {ollama}、ブラウザ {browser}、デスクトップ {desktop}。ローカル AI は同時に {parallel} 件のリクエストを処理します。",
  "systemProfile.loadFailed": "デスクトップと電力の設定を読み取れませんでした。",
  "systemProfile.desktopFailed": "デスクトップの設定を変更できませんでした。",
  "systemProfile.powerFailed": "電力プロファイルを変更できませんでした。",
};
