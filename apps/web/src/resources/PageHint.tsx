import { InfoIcon } from './ResIcons';
import { ToolPop } from './ToolPop';

/** 页面说明：一个小问号，点开才看到那句话，不占版面。 */
export function PageHint({ text }: { text: string }) {
  return (
    <ToolPop label="页面说明" className="res-hint-btn" panelClass="res-hint" sheet={false} trigger={<InfoIcon />}>
      {() => <p className="res-hint-text">{text}</p>}
    </ToolPop>
  );
}
