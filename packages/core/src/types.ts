export type ProjectId = string;

export type EntityId = string;

export type EntityType = "epic" | "story" | "task";

export type TaskStatus = "todo" | "in-progress" | "done" | "archived";

export type EffectiveStatus = TaskStatus | "blocked";

export interface ProjectMarker {
  id: ProjectId;
  title: string;
  created: string;
}

export interface Entity {
  id: EntityId;
  type: EntityType;
  title: string;
  body: string;
  dependsOn: EntityId[];
  tags: string[];
  status?: TaskStatus;
  epicId?: EntityId;
  storyId?: EntityId;
}

export interface Index {
  marker: ProjectMarker;
  entities: Map<EntityId, Entity>;
}

export interface ValidationIssue {
  code: string;
  message: string;
  entityId?: EntityId;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ProjectState {
  id: ProjectId;
  root: string;
  marker: ProjectMarker;
  index: Index;
  validation: ValidationResult;
  updatedAt: string;
}
