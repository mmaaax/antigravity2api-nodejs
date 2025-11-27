import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { generateToolCallId } from '../utils/idGenerator.js';
import AntigravityRequester from '../AntigravityRequester.js';

let requester = null;
let useNativeFetch = false;

if (config.useNativeFetch !== true) {
  try {
    requester = new AntigravityRequester();
  } catch (error) {
    console.warn('AntigravityRequester initialization failed, falling back to native fetch:', error.message);
    useNativeFetch = true;
  }
} else {
  useNativeFetch = true;
}

function processStreamLine(line, state, callback) {
  if (!line.startsWith('data: ')) return;
  
  try {
    const data = JSON.parse(line.slice(6));
    const parts = data.response?.candidates?.[0]?.content?.parts;
    
    if (parts) {
      for (const part of parts) {
        if (part.thought === true) {
          if (!state.thinkingStarted) {
            callback({ type: 'thinking', content: '<think>\n' });
            state.thinkingStarted = true;
          }
          callback({ type: 'thinking', content: part.text || '' });
        } else if (part.text !== undefined) {
          if (state.thinkingStarted) {
            callback({ type: 'thinking', content: '\n</think>\n' });
            state.thinkingStarted = false;
          }
          callback({ type: 'text', content: part.text });
        } else if (part.functionCall) {
          state.toolCalls.push({
            id: part.functionCall.id || generateToolCallId(),
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args)
            }
          });
        }
      }
    }
    
    if (data.response?.candidates?.[0]?.finishReason && state.toolCalls.length > 0) {
      if (state.thinkingStarted) {
        callback({ type: 'thinking', content: '\n</think>\n' });
        state.thinkingStarted = false;
      }
      callback({ type: 'tool_calls', tool_calls: state.toolCalls });
      state.toolCalls = [];
    }
  } catch (e) {
    // 忽略解析错误
  }
}

export async function generateAssistantResponse(requestBody, callback) {
  const token = await tokenManager.getToken();
  
  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }
  
  const headers = {
    'Host': config.api.host,
    'User-Agent': config.api.userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
  
  const state = { thinkingStarted: false, toolCalls: [] };
  let buffer = '';
  
  const processChunk = (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(line => processStreamLine(line, state, callback));
  };
  
  if (useNativeFetch) {
    const response = await fetch(config.api.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 403) tokenManager.disableCurrentToken(token);
      throw new Error(`API请求失败 (${response.status}): ${errorBody}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      processChunk(decoder.decode(value, { stream: true }));
    }
  } else {
    const streamResponse = requester.antigravity_fetchStream(config.api.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    let errorBody = '';
    let statusCode = null;

    await new Promise((resolve, reject) => {
      streamResponse
        .onStart(({ status }) => {
          statusCode = status;
          if (status === 403) tokenManager.disableCurrentToken(token);
        })
        .onData((chunk) => {
          if (statusCode !== 200) {
            errorBody += chunk;
          } else {
            processChunk(chunk);
          }
        })
        .onEnd(() => {
          if (statusCode !== 200) {
            reject(new Error(`API请求失败 (${statusCode}): ${errorBody}`));
          } else {
            resolve();
          }
        })
        .onError(reject);
    });
  }
}

export async function getAvailableModels() {
  const token = await tokenManager.getToken();
  
  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }
  
  const headers = {
    'Host': config.api.host,
    'User-Agent': config.api.userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
  
  const fetchFn = useNativeFetch ? fetch : (url, opts) => requester.antigravity_fetch(url, opts);
  const response = await fetchFn(config.api.modelsUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({})
  });

  const data = await response.json();
  
  return {
    object: 'list',
    data: Object.keys(data.models).map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'google'
    }))
  };
}



export async function generateAssistantResponseNoStream(requestBody) {
  const token = await tokenManager.getToken();
  
  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }
  
  const headers = {
    'Host': config.api.host,
    'User-Agent': config.api.userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
  
  const fetchFn = useNativeFetch ? fetch : (url, opts) => requester.antigravity_fetch(url, opts);
  const response = await fetchFn(config.api.noStreamUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });
  if (response.status !== 200) {
    const errorBody = await response.text();
    if (response.status === 403) {
      tokenManager.disableCurrentToken(token);
      throw new Error(`该账号没有使用权限，已自动禁用。错误详情: ${errorBody}`);
    }
    throw new Error(`API请求失败 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  //console.log(JSON.stringify(data,null,2))
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  
  let content = '';
  let thinkingContent = '';
  const toolCalls = [];
  
  for (const part of parts) {
    if (part.thought === true) {
      thinkingContent += part.text || '';
    } else if (part.text !== undefined) {
      content += part.text;
    } else if (part.functionCall) {
      toolCalls.push({
        id: part.functionCall.id || generateToolCallId(),
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args)
        }
      });
    }
  }
  
  if (thinkingContent) {
    content = `<think>\n${thinkingContent}\n</think>\n${content}`;
  }
  
  return { content, toolCalls };
}

export function closeRequester() {
  if (requester) {
    requester.close();
  }
}
