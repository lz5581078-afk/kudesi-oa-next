import { useSearchParams } from 'react-router-dom';
import { FlowDirectory } from './FlowDirectory';
import { FlowDesigner } from './FlowDesigner';
import './designer.css';

/** 流程配置：没选流程时是流程目录；选了（?flow=编号）进入该流程的详情与设计器。 */
export function TemplatesPage() {
  const [params, setParams] = useSearchParams();
  const key = params.get('flow');
  const open = (k: string) => setParams({ flow: k });
  if (key) return <FlowDesigner flowKey={key} onBack={() => setParams({})} onOpen={open} />;
  return (
    <div>
      <div className="page-head"><h1>流程配置</h1></div>
      <FlowDirectory onOpen={open} />
    </div>
  );
}
