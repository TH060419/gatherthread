// Documentation-only annotations for real, full-viewport application captures.
// Exact UI geometry is read from the browser; the original image is never rebuilt.
const point = (selector, en, zh, nth = 0) => ({ selector, en, zh, nth });
export const scenes = {
  '01-workspace': [point('#session-list','Choose a conversation','选择项目内的会话'), point('#session-view','Discuss and work together','讨论与 AI 工作放在一起'), point('#member-list','Follow your teammates','查看同伴与进展')],
  '02-discussion': [point('#event-timeline > li','Suggest a goal','提出想做的事情',1), point('#event-timeline > li','Agree on the first version','确认这次要做什么',2), point('#send-chat-button','Chat without starting AI','聊天不会启动 AI')],
  '03-summary': [point('#history-summary-select-button','Select messages to summarize','选取消息生成摘要'), point('#event-timeline > li','Keep an agreed checklist','整理成制作清单',1), point('#history-summary-view-button','Return to the originals','切回查看原文')],
  '04-agent-work': [point('#event-timeline > li','See whose Agent did the work','看清谁的 Agent 做了什么',3), point('#event-timeline > li','Teammates check the result','同伴接着检查成果',4), point('#send-agent-button','Explicitly ask your Agent','明确请求自己的 Agent')],
  '05-quote-and-mention': [point('#composer-quote','Reply to a specific message','引用具体消息'), point('#message-input','Mention a specific teammate','提及具体同伴')],
  '06-mentions': [point('#mentions-list','Open the relevant message','定位提到自己的消息')],
  '07-file-service': [point('#code-provider-github','GitHub for real development','实际开发优先 GitHub'), point('#code-provider-gt-cloud','GT Cloud for small trials','GT Cloud 适合轻量体验'), point('#code-open-branches-view','Review members’ versions','查看同伴文件版本')],
  '07-file-versions': [point('#code-branch-list','Everyone has a file branch','各自先保存文件版本'), point('#code-review-button','Ask for a human review','提交给同伴审核')],
  '08-review-changes': [point('#code-review-files','Inspect the actual files','展开查看文件内容'), point('#code-merge-button','Integrate only after review','确认后再整合')],
  '09-github': [point('#github-code-form','Choose a repository and base','选择仓库和主分支'), point('#github-code-guide > summary','Authorize your computer too','电脑也需单独授权')],
  '10-summary-settings': [point('#settings-history-context-mode','Choose summary or originals','选择摘要或原文'), point('#settings-history-summary-instructions','Customize summary instructions','自定义总结要求')],
  '11-focused-workspace': [point('#session-view','Give the conversation more room','给中间会话留更多空间')],
  '12-phone': [point('#message-input','Continue the discussion','继续共同讨论'), point('#mobile-agent-button','Choose your online Agent','选择自己的在线 Agent')],
  '12-phone-agent': [point('#agent-model-select','Choose a supported model','选择可用模型'), point('#agent-effort-select','Adjust reasoning level','调整思考强度')],
  '13-tablet': [point('#message-input','Keep working on a tablet','在平板上继续讨论'), point('#mobile-agent-button','Open compact Agent controls','展开紧凑的 Agent 设置')],
  '13-tablet-agent': [point('#agent-model-select','Choose a supported model','选择可用模型'), point('#agent-effort-select','Adjust reasoning level','调整思考强度')],
  '14-working-result': [point('#signup','Try the real example button','试一下实际报名按钮'), point('#confirmation','Check the agreed result','检查是否符合约定')],
  '15-history-controls': [point('#import-visible-history-button','Import into a new local task','导入新的本地任务'), point('.codex-auto-upload-control','Control local-to-cloud upload','开关本地自动上传'), point('#upload-local-turns-button','Manually upload completed turns','手动补传已完成回合')],
};
