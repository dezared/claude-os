// What the screen asks Claude in a new tab. The learn skill holds the how; these say what and where.
const SKILL = 'Use the learn skill and the learn_* tools.';

export const newTrackPrompt = (topic) => [
  SKILL,
  `I want to learn: ${topic.trim()}`,
  'Ask me what you need to know first (at most three short questions), then create a track with a roadmap and offer to write the first lesson.',
].filter(Boolean).join('\n\n');

export const importPrompt = (plugin) => [
  SKILL,
  `Import my Claude OS plugin "${plugin.name}" (folder ${plugin.path}) as a learning track. Read its skills and their files fully, map its program onto the roadmap and keep its audience, page structure and rules as the track's style. Save its program, templates and reference files as the track's materials with learn_save_material. Set source to that folder. Do not change the plugin itself.`,
  'When every step and material is in the track, tell me the plugin can now be disabled on the plugins screen: the course lives in Learn.',
].filter(Boolean).join('\n\n');

export const lessonPrompt = (track, node, rewrite) => [
  SKILL,
  `${rewrite ? 'Rewrite' : 'Write'} the lesson for the node "${node.title}" (id ${node.id}) of the track "${track.title}" (id ${track.id}): read the track first, then save the lesson with its quiz, videos and practice.`,
].filter(Boolean).join('\n\n');

export const roadmapPrompt = (track) => [
  SKILL,
  `Let us review the roadmap of the track "${track.title}" (id ${track.id}). Read it with my progress and grades, suggest changes, and apply them with learn_update_roadmap once I agree.`,
].filter(Boolean).join('\n\n');

export const practicePrompt = (track, node, lesson) => [
  SKILL,
  `Practice for the lesson "${lesson.title}" (track ${track.id}, node ${node.id}). We work in this folder.`,
  lesson.practice ? `The task: ${lesson.practice.task}` : 'There is no task yet: make one that fits the lesson.',
  lesson.practice?.files?.length ? `The lesson carries the exercise files: read them with learn_get_lesson and write them into the folder ${node.id} here unless it already has them; never overwrite a file I changed.` : '',
  lesson.practice?.check ? `A solution is checked with: ${lesson.practice.check}` : '',
  'Set the exercise up here, let me write the solution myself with hints when I ask, then check it and record a grade with learn_record_grade.',
].filter(Boolean).join('\n\n');
