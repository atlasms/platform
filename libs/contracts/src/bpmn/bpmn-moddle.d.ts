// bpmn-moddle 10 types its element model (`bpmn-moddle/types`) but not its entry point, and the
// entry point is all the converter calls: the constructor and three methods. This declares that
// much. Elements are read through `ModdleObject`'s index signature as `unknown` and narrowed where
// they are read (import.ts), rather than trusting a shape a foreign file may not have.
declare module 'bpmn-moddle' {
  export interface ModdleObject {
    $type: string;
    [property: string]: unknown;
  }
  export interface ParseWarning {
    message: string;
  }
  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>);
    create(type: string, properties?: Record<string, unknown>): ModdleObject;
    fromXML(xml: string): Promise<{ rootElement: ModdleObject; warnings: ParseWarning[] }>;
    toXML(element: ModdleObject, options?: { format?: boolean }): Promise<{ xml: string }>;
  }
}
