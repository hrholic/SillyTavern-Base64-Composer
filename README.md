# SillyTavern Base64 整段转换

一个独立、纯前端的 SillyTavern 扩展。它只处理当前发送输入框中的文字，不调用 API、不自动发送，也不修改历史消息。

## 功能

- 轻点半透明 `B64` 悬浮窗：将输入框中的整段文字按 UTF-8 编码为标准 Base64，并替换原文。
- 长按悬浮窗约 500ms：只打开更多选项，不执行转换；菜单中可以撤销最近一次转换。
- 拖动悬浮窗：适配鼠标和手机触摸；移动超过阈值会取消轻点和长按动作。
- 支持中文、emoji、空格、Tab 和换行；转换前会在本地解码并逐字校验。
- 空输入不操作；连续误点不会把刚生成的 Base64 再编码一次。
- 转换后只要手动改过输入框，扩展撤销就会立即失效，避免覆盖新内容。
- 长文本使用分块字节处理，但输出始终是一整段标准 Base64，不做五段或其他分段。

> Base64 只能保证编码与解码可逆，不能保证聊天模型一定能正确理解 Base64 内容。

## 安装（推荐）

1. 在 SillyTavern 打开“扩展”面板。
2. 点击“安装扩展”，粘贴仓库地址：
   `https://github.com/hrholic/SillyTavern-Base64-Composer`
3. 按界面提示完成安装，然后刷新页面；如扩展显示为停用，请手动启用“Base64 整段转换”。

## 手动安装（Android Termux / 桌面）

1. 解压发布的 ZIP，得到 `SillyTavern-Base64-Composer` 文件夹。
2. 把整个文件夹放到 SillyTavern 的当前用户扩展目录：
   `SillyTavern/data/<你的用户目录>/extensions/`
3. 确认最终路径是：
   `SillyTavern/data/<你的用户目录>/extensions/SillyTavern-Base64-Composer/manifest.json`
4. 重启 SillyTavern，或刷新浏览器页面；如扩展管理页显示为停用，请手动启用“Base64 整段转换”。

常见的 Termux 安装根目录是：
`/data/data/com.termux/files/home/SillyTavern/`

不同安装方式的根目录可能不同；`<你的用户目录>` 也可能是 `default-user` 或你自己创建的用户目录。

## 使用

- 先在 SillyTavern 输入框中写好原文，再轻点 `B64`。
- 长按 `B64` 约 500ms 展开菜单；长按后松手不会转换。
- 在菜单中点“撤销转换”可恢复最近一次原文。
- 按住并移动 `B64` 可拖动；位置会保存在当前浏览器中。

## 隐私与范围

- 无网络请求、无第三方依赖。
- 不调用模型/API，不触发发送按钮。
- 不读写聊天记录，只读取并替换 `#send_textarea` 的当前值。
- 不会自动更新（`auto_update: false`）；更新由用户自行确认和执行。

## 本地测试

需要 Node.js 20 或更高版本：

```bash
npm test
```

自动测试覆盖 UTF-8/Base64 往返、中文、emoji、混合换行与空格、长文、空输入、防重复、撤销安全、轻点/长按/拖动互斥、鼠标与模拟触摸，以及移动视口边界约束。

这些测试是 Node.js 中的逻辑与交互状态模拟，并不等同于在真实 SillyTavern、Android Chrome 或桌面浏览器中的人工安装测试。
