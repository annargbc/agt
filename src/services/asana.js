import 'dotenv/config';
import Asana from 'asana';
import _ from 'lodash';
import { findTaskId } from '../helpers/tasks';

export const client = Asana.Client.create().useAccessToken(process.env.ASANA_PATOKEN);

export const setupCustomFields = async () => {
  const field = await client.customFields.create({
    workspace: process.env.ASANA_WORKSPACE_ID,
    resource_subtype: 'enum',
    name: process.env.ASANA_CUSTOM_FIELD_NAME,
    description: 'The current stage of this feature',
    enum_options: [
      { name: 'Draft', color: 'cool-gray' },
      { name: 'In Progress', color: 'aqua' },
      { name: 'Review', color: 'yellow' },
      { name: 'Approved', color: 'green' },
      { name: 'Staging', color: 'magenta' },
      { name: 'Production', color: 'indigo' }
    ]
  });
  await client.projects.addCustomFieldSetting(process.env.ASANA_PROJECT_ID, {
    custom_field: field.gid,
    is_important: true
  });

  console.log('Successfully created custom fields and added to project');
};

export const getHooks = async () => {
  return client.webhooks.getAll(process.env.ASANA_WORKSPACE_ID, {
    resource: process.env.ASANA_PROJECT_ID
  });
};

export const createHooks = async () => {
  client.webhooks.create(process.env.ASANA_PROJECT_ID, `${process.env.BASE_URL}/webhooks/asana`);
};

export const getTask = async gid => {
  return client.tasks.findById(gid);
};

export const searchTask = async text => {
  return client.tasks.search(process.env.ASANA_WORKSPACE_ID, { text });
};

export const addCommentToTask = async ({ gid, htmlText }) => {
  client.tasks.addComment(gid, {
    html_text: htmlText
  });
};

export const getCurrentIdFromProject = project => {
  const regex = /\[currentTaskId:(.+?)\]/;
  const match = project.notes.match(regex);
  if (match) {
    return parseInt(match[1], 10);
  }

  return 0;
};

export const getCurrentTaskId = async () => {
  const project = await client.projects.findById(process.env.ASANA_PROJECT_ID);
  return getCurrentIdFromProject(project);
};

export const setCurrentTaskId = async number => {
  const project = await client.projects.findById(process.env.ASANA_PROJECT_ID);
  const currentId = getCurrentIdFromProject(project);
  const current = `[currentTaskId: ${currentId}]`;
  let updated = `[currentTaskId: ${number}]`;

  if (currentId > 0) {
    updated = project.notes.replace(current, updated);
  }

  await client.projects.update(process.env.ASANA_PROJECT_ID, {
    notes: updated
  });
};

// Handling hooks
export const handleHooks = async req => {
  const body = JSON.parse(req.body);
  let number = await getCurrentTaskId();

  _.each(body.events, (event, i) => {
    const { action, resource = {}, parent = {} } = event;
    if (resource && parent) {
      const { gid, resource_type: resourceType } = resource;
      const { resource_type: parentResourceType } = parent;

      if (action === 'added' && resourceType === 'task' && parentResourceType === 'project') {
        number += 1;
        handleTaskCreated({
          gid,
          number
        });
      }
    }
  });

  setCurrentTaskId(number);
};

export const getCustomField = async customFields => {
  return _.find(customFields, { name: process.env.ASANA_CUSTOM_FIELD_NAME });
};

export const getCustomFieldOption = ({ name, field }) => {
  const { enum_options: enumOptions } = field;
  return _.find(enumOptions, { name });
};

export const handleTaskCreated = async ({ gid, number }) => {
  const task = await getTask(gid);
  const { name } = task;

  const updatedName = `[${process.env.ASANA_PROJECT_PREFIX}-${number}] ${name}`;

  const field = _.find(task.custom_fields, { name: process.env.ASANA_CUSTOM_FIELD_NAME });
  const { enum_options: enumOptions, enum_value: enumValue, gid: customFieldGid } = field;
  const draftOption = _.find(enumOptions, { name: 'Draft' });
  const taskId = findTaskId(name);

  if (!taskId) {
    await client.tasks.update(gid, {
      name: updatedName,
      custom_fields: {
        [customFieldGid]: draftOption.gid
      }
    });
  }
};
