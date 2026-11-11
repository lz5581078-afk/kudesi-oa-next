'use strict';

// Runs in the source frame. Only explicit, visible source indicators count as evidence.
function readJushuitanRecordingStatus(row, headers) {
  const columnNames = new Set(['视频监控', '录像', '录像状态', '视频监控状态', '是否有录像', '有无录像']);
  const positives = new Set(['有录像', '已有录像', '有视频', '有监控录像']);
  const negatives = new Set(['无录像', '没有录像', '暂无录像', '无视频', '暂无视频', '无监控录像']);
  const videoTooltips = new Map([
    ['点击观看视频', 'available'],
    ['售后单以及其关联的订单均未有监控视频录制，无法查看视频', 'unavailable'],
  ]);
  const visible = element => !!element?.getClientRects().length &&
    getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden],[aria-hidden="true"]');
  const controlColumns = new Set(['售后单号','内部订单号','操作']);
  const values = new Set();

  function collect(raw, isStatusCell) {
    const label = String(raw ?? '').trim()
      .replace(/^(?:视频监控|录像状态|是否有录像)\s*[:：]\s*/, '');
    if (positives.has(label) || (isStatusCell && (label==='有'||label==='是'))) values.add('available');
    if (negatives.has(label) || (isStatusCell && (label==='无'||label==='否'))) values.add('unavailable');
  }

  for (const [index,cell] of [...row.children].entries()) {
    if (!visible(cell)) continue;
    const statusCell = columnNames.has(headers[index]);
    const controlColumn = controlColumns.has(headers[index]);
    if (statusCell || controlColumn) collect(cell.innerText ?? cell.textContent, statusCell);
    const attributes='[title],[aria-label],[data-original-title],img[alt]';
    const selector=statusCell||controlColumn?attributes+',button,[role="status"],a,span':attributes;
    const elements = [cell,...cell.querySelectorAll(selector)];
    for (const element of elements) {
      if (!visible(element)) continue;
      for (const attribute of ['title','aria-label','data-original-title','alt']) {
        const label=element.getAttribute(attribute);
        const tooltipStatus=attribute!=='alt'&&videoTooltips.get(label?.trim());
        if(tooltipStatus)values.add(tooltipStatus);
        else if(statusCell||controlColumn||/^(?:视频监控|录像状态|是否有录像)\s*[:：]/.test(label||''))collect(label,statusCell);
      }
      if (element!==cell && element.children.length===0 && (statusCell||controlColumn)) {
        collect(element.innerText ?? element.textContent,statusCell);
      }
    }
  }
  return values.size===1?[...values][0]:undefined;
}

module.exports={readJushuitanRecordingStatus};
