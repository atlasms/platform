// `@atlas/contracts/bpmn` — the workflow DSL to and from BPMN 2.0 with diagram interchange
// (bms-workflow-dsl-and-designer.md §11; EP-23.2). A subpath so bpmn-moddle loads only where a
// workflow is imported or exported.
export { exportBpmn } from './export.ts';
export {
  importBpmn,
  ImportFailure,
  type ImportOptions,
  type UnsupportedElement,
} from './import.ts';
export { ATLAS_NS, atlasDescriptor, newModdle, toBpmnId, fromBpmnId } from './moddle.ts';
export {
  SHAPE,
  boundsOf,
  positionOf,
  waypoints,
  placeSteps,
  type Bounds,
  type Point,
} from './layout.ts';
