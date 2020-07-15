import 'dotenv/config';
import _ from 'lodash';
import { Octokit } from '@octokit/rest';
import crypto from 'crypto';
import {
  getTask,
  searchTask,
  addCommentToTask,
  getCustomField,
  getCustomFieldOption,
  client
} from './asana';

const octokit = new Octokit({
  auth: `token ${process.env.GITHUB_PATOKEN}`
});

export const listCommits = async number => {
  const res = await octokit.pulls.listCommits({
    owner: process.env.GITHUB_OWNER_NAME,
    repo: process.env.GITHUB_REPO_NAME,
    pull_number: number
  });
  return res.data;
};

export const createHook = async () => {
  const result = await octokit.repos.createHook({
    owner: process.env.GITHUB_OWNER_NAME,
    repo: process.env.GITHUB_REPO_NAME,
    config: {
      content_type: 'json',
      url: `${process.env.BASE_URL}/webhooks/github`,
      secret: process.env.GITHUB_WEBHOOK_SECRET
    },
    events: ['push', 'pull_request', 'pull_request_review', 'deployment_status']
  });
};

const findTaskId = ref => {
  return ref.split('/')[2];
};

export const handleHooks = req => {
  const body = JSON.parse(req.body);
  const type = req.headers['x-github-event'];

  switch (type) {
    case 'push':
      handleCommit(body);
      break;
    case 'pull_request':
      handlePullRequest(body);
      break;
    case 'pull_request_review':
      handlePullRequestReview(body);
      break;
    default:
      console.log('unrecognized event');
  }
};

const excludedRefs = _.map(
  [process.env.PRODUCTION_BRANCH_NAME, process.env.STAGING_BRANCH_NAME],
  name => `refs/heads/${name}`
);

export const handleCommit = async ({ ref, commits }) => {
  // Dont handle direct commits / merges to the production and staging branches
  if (_.includes(excludedRefs, ref)) return;

  _.each(commits, async commit => {
    const {
      url,
      committer: { name }
    } = commit;
    const taskId = findTaskId(ref);

    if (taskId) {
      const response = await searchTask(taskId);
      _.each(response.data, async searchedTask => {
        const task = await getTask(searchedTask.gid);
        const { gid, custom_fields: customFields } = task;
        const { enum_value: { name: stage } } = await getCustomField(customFields);
        if (stage && stage === 'Draft') {
          setStage({ stage: 'In Progress', task });
        }

        addCommentToTask({
          gid,
          htmlText: `<body><a href='${url}'>Commit 🛠</a> by <em>${name}</em></body>`
        });
      });
    }
  });
};

const getTaskIdsFromPullRequest = async number => {
  const collection = await listCommits(number);
  return _.compact(_.uniq(_.map(collection, ({ commit: { message } }) => findTaskId(message))));
};

export const handlePullRequest = async ({
  action,
  number,
  pull_request: {
    merged,
    user: { login },
    html_url: url,
    base: { ref: baseRef },
    head: { ref: headRef }
  }
}) => {
  const response = await searchTask( '[' + headRef + ']' );
  _.each(response.data, task => {
    switch (action) {
      case 'opened':
        addCommentToTask({
          gid: task.gid,
          htmlText: `<body><a href='${url}'>PR #${number} / Opened 💬 (${headRef} ➡️ ${baseRef})</a> by <em>${login}</em></body>`
        });
        setStage({
          stage: 'Review',
          task
        });
        break;
      case 'closed':
        if (merged) {
          addCommentToTask({
            gid: task.gid,
            htmlText: `<body><a href='${url}'>PR #${number} / Merged 🏆 (${headRef} ➡️️ ${baseRef})</a> by <em>${login}</em></body>`
          });
        }
        if (baseRef === process.env.STAGING_BRANCH_NAME) {
          setStage({
            stage: 'Staging',
            task
          });
        }
        if (baseRef === process.env.PRODUCTION_BRANCH_NAME) {
          setStage({
            stage: 'Production',
            task
          });
        }
        break;
      default:
    }
  });
};

export const handlePullRequestReview = async ({
  action,
  pull_request: {
    number,
    html_url: url,
    head: { ref: headRef },
    base: { ref: baseRef }
  },
  review: {
    user: { login },
    state
  }
}) => {
  if (action === 'submitted' && state === 'approved') {
    const taskIds = await getTaskIdsFromPullRequest(number);
    _.each(taskIds, async taskId => {
      const response = await searchTask(taskId);
      _.each(response.data, task => {
        addCommentToTask({
          gid: task.gid,
          htmlText: `<body><a href='${url}'>PR #${number} / Approved ✅ (${headRef} ➡️️ ${baseRef})</a> by <em>${login}</em></body>`
        });
        setStage({
          stage: 'Approved',
          task
        });
      });
    });
  }
};

const setStage = async ({ stage, task: searchedTask }) => {
  const { gid, custom_fields: customFields } = await getTask(searchedTask.gid);
  const customField = await getCustomField(customFields);
  const customFieldOption = getCustomFieldOption({
    name: stage,
    field: customField
  });

  client.tasks.update(gid, {
    custom_fields: {
      [customField.gid]: customFieldOption.gid
    }
  });
};

export const verifyGitHub = req => {
  if (!req.headers['user-agent'].includes('GitHub-Hookshot')) {
    return false;
  }
  // Compare their hmac signature to our hmac signature
  // (hmac = hash-based message authentication code)
  const theirSignature = req.headers['x-hub-signature'];
  const body = JSON.parse(req.body);
  const payload = JSON.stringify(body);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  const ourSignature = `sha1=${crypto
    .createHmac('sha1', secret)
    .update(payload)
    .digest('hex')}`;

  return crypto.timingSafeEqual(Buffer.from(theirSignature), Buffer.from(ourSignature));
};
