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
The project member who manages the project, invitations, member roles, and multi sessions. Project ownership does not grant write access to another member's Personal Solo Session.
_Avoid_: Deployment operator, session owner

**Project Participant**:
A project member who may contribute to multi sessions, create and write their own Personal Solo Sessions, and read every other member's solo sessions without modifying them.
_Avoid_: Editor, session participant

**Project Viewer**:
A project member whose access to every cloud session in the project is read-only. A local agent conversation created by a Project Viewer remains local and never creates a cloud session.
_Avoid_: Guest, observer

**Personal Solo Session**:
A solo session owned by the Project Owner or Project Participant who created it. Only that Solo Creator may modify or publish local-agent turns to it while they retain a non-viewer project role; every other project member, including the Project Owner, is read-only.
_Avoid_: Owner-only project, private session, multi session

**Solo Creator**:
The Project Member recorded as the owner of one Personal Solo Session. This authority is session-scoped and does not imply Project ownership.
_Avoid_: Project Owner, deployment operator

**Project Invitation**:
A single-use invitation to join a project as either a Project Participant or Project Viewer, including access to the project's current and future sessions.
_Avoid_: Session invitation, public registration
