# GatherThread Collaboration

GatherThread organizes collaboration between people and their local agents. A shared project is the stable collaboration scope; conversations inside it remain independently ordered and contextualized.

## Language

**Project**:
The top-level collaboration space that represents one shared body of work and groups its related sessions.
_Avoid_: Workspace, room, standalone session

**Session**:
A solo or multi conversation inside exactly one project, with its own canonical history and local-agent conversation state.
_Avoid_: Project, room

**Local Project Binding**:
A private association between one GatherThread project and one collaborator's local agent project, including the local working directory and chosen harness settings.
_Avoid_: Session binding, shared filesystem

**Project Connection**:
The act and resulting device-local state that establish one Local Project Binding for a Project and make that member's eligible session conversations available to a local agent. A Project Connection never grants permissions beyond the member's existing Project role.
_Avoid_: Session connection, project invitation, shared filesystem mount

**Canonical Session History**:
The authoritative ordered event history of one session. It does not implicitly include the histories of sibling sessions in the same project.
_Avoid_: Project history, native harness transcript

**Local Agent Conversation**:
The harness-native conversation maintained for one session under a Local Project Binding. Different sessions in the same project use separate local agent conversations.
_Avoid_: Project-wide agent conversation

**Project Member**:
A person admitted to a project. Their effective permissions within a session depend on the project role and that session's mode.
_Avoid_: Session-only identity

**Project Owner**:
The project member who manages the project, its sessions, invitations, and the roles of every other member.
_Avoid_: Deployment operator, session owner

**Project Participant**:
A project member who may contribute to multi sessions and may read, but never modify, solo sessions.
_Avoid_: Editor, session participant

**Project Viewer**:
A project member whose access to every session in the project is read-only.
_Avoid_: Guest, observer

**Project Invitation**:
A single-use invitation to join a project as either a Project Participant or Project Viewer, including access to the project's current and future sessions.
_Avoid_: Session invitation, public registration
