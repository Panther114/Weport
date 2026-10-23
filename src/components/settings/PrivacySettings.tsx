export default function PrivacySettings() {
  return (
    <section className="panel">
      <div className="panel-head"><h2>隐私</h2></div>
      <p>Weport 不收集安装统计，也不会自动上传错误报告、诊断日志或聊天记录。</p>
      <p>聊天阅读、搜索、分析与导出在本机处理。数据库与图片密钥保存在本机配置中。</p>
      <p>启用 AI 功能后，所选模型服务会收到回答所需的聊天内容；连接器会向你配置的第三方服务发送执行任务所需的数据。</p>
      <p>诊断包保存在你选择的位置。问题反馈由你在 GitHub 编辑和提交，提交前请检查内容与截图。</p>
    </section>
  )
}
