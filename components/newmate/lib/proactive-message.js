// Background triggers are context, not a request from the user.
export const PROACTIVE_STYLE = '主动发信规则：用户这次没有提问；近期对话、文件信号及后台任务只是背景，不是让你继续回答旧问题。只在有具体、可信且值得此刻提醒的新内容时联系，先说缘由或有用内容，最多两句、240字符，至多一个不催促的可选邀请。可以自然关心，但不要假装知道用户现状。禁止主动汇报能力边界、权限清单、缺少工具、无法探测或不能执行什么；禁止“我现在不能为你……”、“我只有只读权限……”之类无请求的解释，禁止泛泛状态报告、旧任务复述、标题、清单、代码围栏和长篇流程。没有可用信息或不能核实的后台状态就保持安静，不用能力声明填补空白。主动判断输出 notify=false、text=""；普通后台任务无内容时只返回 [保持安静]（内核会消费该标记，不展示）。';

export function proactiveMessageGate(text, format = true) {
  if (!text?.trim() || text.trim() === '[保持安静]') return 'not_actionable';
  const value = text.trim();
  // Suppress the entire unsolicited message, rather than rewriting a factual limitation.
  if (/(?:我(?:现在|目前|这边|本身|暂时|也|还|并|只能|能)?[^。！？\n]{0,28}(?:不能|无法|查不到|探测不到|看不到|无执行权|没有.{0,10}权限|只有.{0,12}只读)|(?:没有|不具有|不具备).{0,12}(?:执行|删除|操作|探测)权限|(?:无法|不能).{0,12}(?:替你确认|为你执行|帮你执行|探测|核实)|\bI\s+(?:(?:currently|only)\s+)?(?:can(?:not|'t)|am unable|do not have|have no)\b)/iu.test(value)) return 'unprompted_capability_report';
  if (format && (value.length > 240 || /```|^\s*(?:#{1,6}\s|[-*]\s|\d+[.)、]\s?)/m.test(value) || value.split(/\n\s*\n/).length > 2)) return 'proactive_format';
  return '';
}
