import requestF from "request";
import jwt from "jsonwebtoken";
import fs from "fs";

import VapiTools from "./vapiTools/registry";
import { SESSION_KEY } from "../common/Const";
import RedisVent from "./RedisVent";
import Utilities from "./Utilities";
import EventEmitter from "events";
import Path from "./Path";
import DB from "../../DB";

const SESSION_EVENTS = {
    START: "start",
    END: "end",
    ERROR: "error",
    UPDATE: "update"
};

export class Vapi {
    #token;
    #tools = {};
    #sessions = {};
    #host;
    #event = new EventEmitter();
    #assistants = {};
    #phoneId;
    constructor(orgId, key, host, phoneId) {
        this.#token = this.generateToken(orgId, key);
        this.#host = host;
        this.#phoneId = phoneId;
        this.listen();
        this.init();
    }
    get Bearer() {
        return `Bearer ${this.#token}`;
    }
    get Event() {
        return this.#event;
    }
    async init() {
        try {

            for (const vt of VapiTools) {
                const config = vt.assistant;
                config.serverUrl = this.#host + "/api/session";
                const tools = vt.tools;
                const newConfig = await this.createTools(config, tools);
                await this.createAssistant(newConfig);
            }
            // const squads = await this.listSquad();
            // const response = await this.deleteSquad(squads[0].id);
            // console.log("Squad deleted! response: ", response);
            const response = await this.createSquad();
            Utilities.showDebug("Squad created! response: %s", JSON.stringify(response));
            const updatePhone = await this.updatePhonenumber(this.#phoneId, response.id);
            Utilities.showDebug("Phone number updated! response: %s", JSON.stringify(updatePhone));
        } catch (error) {
            Utilities.showError("Error initializing VAPI! err: %s", error.message || error);
        }
    }
    /**
     * @param {String} eventName 
     * @param {Function} callback 
     */
    on(eventName, callback) {
        if (typeof callback !== "function") throw new Error("Callback must be a function");
        switch (eventName) {
            case SESSION_EVENTS.START:
            case SESSION_EVENTS.END:
            case SESSION_EVENTS.ERROR:
                if (this.#event.listenerCount(eventName) < 1)
                    this.#event.on(eventName, callback);
                break;
            default:
                throw new Error("Invalid event");
        }
    }
    listen() {
        this.on(SESSION_EVENTS.END, (sessionId) => {
            delete this.#sessions[sessionId];
            Utilities.showDebug("Session ended! id: %s", sessionId);
        });
    }
    /** 
     * @param {String} id
     * @returns {import("./vapiTools/template").FuncTemplate}
    */
    getTools(id) {
        return this.#tools[id];
    }
    generateToken(orgId, key) {
        return jwt.sign({ orgId }, key, { expiresIn: "30min" });
    }
    requestPromise(options) {
        return new Promise((resolve, reject) => {
            requestF(options, (err, resp, body) => {
                if (err) reject(err);
                else resolve(body);
            });
        });
    }
    recordAssistants(assistants = []) {
        const getTools = (toolsInstances, tools) => {
            return tools.map(tool => {
                const instance = toolsInstances.find(t => t.Id === tool.function.name);
                if (instance) return instance;
                return null;
            });
        };
        assistants.forEach(assistant => {
            const vt = VapiTools.find(vt => vt.assistant.name === assistant.name);
            const tools = vt.tools;
            this.#assistants[assistant.id] = {
                name: assistant.name,
                message: assistant.firstMessage,
                description: assistant.model.messages[0].content,
                tools: getTools(tools, assistant.model.tools)
            };
        });
    }
    /**
     * 
     * @returns {Promise<Array>}
     */
    async listAssistants() {
        try {
            const options = {
                url: "https://api.vapi.ai/assistant",
                method: 'GET', headers: { Authorization: this.Bearer }
            };
            const response = await this.requestPromise(options);
            const parsed = JSON.parse(response);
            if (parsed && parsed.length) {
                this.recordAssistants(parsed);
                return parsed;
            }
            return [];
        } catch (error) {
            Utilities.showError("Error listing assistants! err: %s", error.message || error);
        }
    }
    async updateAssistant(assistantId, config) {
        try {
            if (assistantId && config) {
                const options = {
                    url: `https://api.vapi.ai/assistant/${assistantId}`,
                    method: 'PATCH',
                    headers: { Authorization: this.Bearer, 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                };
                const response = await this.requestPromise(options);
                Utilities.showDebug("Assistant updated! response: %s", JSON.parse(response));
                return response;
            }
            throw new Error("Missing assistantId or configuration!");
        } catch (error) {
            Utilities.showError("Error updating assistant! err: %s", error.message || error);
        }
    }
    async createAssistant(config) {
        try {
            if (config) {
                const list = await this.listAssistants();
                const exists = list.find(assistant => assistant.name == config.name);
                if (exists) {
                    Utilities.showDebug("Assistant already exists! name: %s", config.name);
                    return await this.updateAssistant(exists.id, config);
                }
                const options = {
                    url: "https://api.vapi.ai/assistant",
                    method: "POST",
                    headers: { Authorization: this.Bearer, "Content-Type": "application/json" },
                    body: JSON.stringify(config)
                };
                const response = await this.requestPromise(options);
                Utilities.showDebug("Assistant created! response: %s", JSON.parse(response));
                const parsed = JSON.parse(response);
                if (parsed.statusCode && parsed.statusCode !== 200) {
                    throw new Error(parsed.error);
                }
                return response;
            }
            throw new Error("Missing configuration!");
        } catch (error) {
            Utilities.showError("Error creating assistant! err: %s", error.message || error);
        }
    }
    async createTools(config, tools = []) {
        try {
            if (config) {
                for (const tool of tools) {
                    try {
                        tool.setServer({ url: this.#host + "/api/info" });
                        await tool.verify();
                        config.model.tools.push(tool.toObject());
                        this.#tools[tool.Id] = tool;
                    } catch (err) {
                        Utilities.showError("Error creating tool! name: %s,  err: %s", tool.Id, err.message || err);
                    }
                }
                return config;
            }
            throw new Error("Missing configuration!");
        } catch (error) {
            Utilities.showError("Error creating tools! err: %s", error.message || error);
            throw new Error(error.message || error);
        }
    }
    getSessionId(parsed) {
        if (parsed && parsed.message && parsed.message.call)
            return parsed.message.call.squadId ? parsed.message.call.phoneCallProviderId : parsed.message.call.id;
        return null;
    }
    /**
     * 
     * @param {Object} requestBody 
     * @returns {Session}
     */
    createSession(requestBody) {
        let parsed = requestBody;
        if (typeof requestBody === "string") {
            parsed = JSON.parse(requestBody);
        }
        const sessionId = this.getSessionId(parsed);
        if (sessionId) {
            if (!this.#sessions[sessionId])
                this.#sessions[sessionId] = new Session(parsed.message.call, this.#event, this.#assistants);
            return this.#sessions[sessionId];
        }
        return null;
    }
    async createSquad() {
        try {
            const checkExists = (members = [], list = []) => {
                for (const l of list) {
                    const m = l.members;
                    const exists = m.every((member, index) => {
                        return member.assistantId === members[index].assistantId;
                    });
                    if (exists) return true;
                }
                return false;
            };
            const body = { members: [] };
            const taskRouter = { assistantId: "", assistantDestinations: [] };
            const messageTemplate = "Please wait a moment.";
            for (const id in this.#assistants) {
                const assistant = this.#assistants[id];
                if (assistant && assistant.name.includes("Task Router")) {
                    taskRouter.assistantId = id;
                } else {
                    taskRouter.assistantDestinations.push({
                        type: "assistant",
                        assistantName: assistant.name,
                        message: messageTemplate,
                        description: assistant.description
                    });
                    body.members.push({ assistantId: id });
                }
            }
            body.members.unshift(taskRouter);
            const list = await this.listSquad();
            const exist = checkExists(body.members, list);
            if (exist) {
                Utilities.showDebug("Squad already exists!");
                return await this.updateSquad(list[0].id, body);
            }
            const options = {
                url: "https://api.vapi.ai/squad",
                method: 'POST',
                headers: { Authorization: this.Bearer, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            };
            const response = await this.requestPromise(options);
            return JSON.parse(response);
        } catch (error) {
            Utilities.showError("Error creating squad! err: %s", error.message || error);
            throw new Error(error.message || error);
        }
    }
    listSquad() {
        const options = {
            url: 'https://api.vapi.ai/squad',
            method: 'GET', headers: { Authorization: this.Bearer }
        };
        return this.requestPromise(options).then(response => JSON.parse(response));
    }
    deleteSquad(id) {
        const options = {
            url: `https://api.vapi.ai/squad/${id}`,
            method: 'DELETE', headers: { Authorization: this.Bearer }
        };
        return this.requestPromise(options).then(response => JSON.parse(response));
    }
    updateSquad(id, body) {
        const options = {
            url: `https://api.vapi.ai/squad/${id}`,
            method: 'PATCH',
            headers: { Authorization: this.Bearer, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        };
        return this.requestPromise(options).then(response => JSON.parse(response));
    }
    getAssistant(assistantId) {
        const options = {
            url: `https://api.vapi.ai/assistant/${assistantId}`,
            method: 'GET', headers: { Authorization: this.Bearer }
        };
        return this.requestPromise(options).then(response => JSON.parse(response));
    }
    updatePhonenumber(id, squadId) {
        const body = { name: "Crespa", squadId, };
        const options = {
            url: `https://api.vapi.ai/phone-number/${id}`,
            method: 'PATCH',
            headers: { Authorization: this.Bearer, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        };
        return this.requestPromise(options).then(response => JSON.parse(response));
    }
    getCall(callId) {
        const options = {
            url: `https://api.vapi.ai/call/${callId}`,
            method: 'GET', headers: { Authorization: this.Bearer }
        };
        return this.requestPromise(options).then(response => JSON.parse(response));
    }
    /**
     * 
     * @param {*} artifact 
     * @returns {import("./vapiTools/template").FuncTemplate | null}
     */
    getToolArtifact(artifact) {
        const toolRequests = artifact.messages.filter(message => message.role === "tool_calls");
        const lastMessage = toolRequests[toolRequests.length - 1];
        if (lastMessage && lastMessage.toolCalls && lastMessage.toolCalls.length) {
            const f = lastMessage.toolCalls.find(call => call.type === "function");
            if (f) {
                return this.#tools[f.function.name];
            }
        }
        return null;
    }
    getToolCalls(toolCalls) {
        const lastMessage = toolCalls[toolCalls.length - 1];
        if (lastMessage && lastMessage.type === "function") {
            return this.#tools[lastMessage.function.name];
        }
        return null;
    }
    /**
     * 
     * @param {*} artifact 
     * @returns {import("./vapiTools/template").FuncTemplate | null}
     */
    getTool(parsed) {
        switch (parsed.message.type) {
            case "tool-calls":
                return this.getToolCalls(parsed.message.toolCalls);
            case "function-call":
            default:
                return this.getToolArtifact(parsed.message.artifact);
        }
    }
    /**
     * 
     * @param {*} requestBody 
     * @returns {Promise<{statusCode:Number, message: Object}>}
     */
    parseRequest(requestBody) {
        return new Promise((resolve) => {
            let parsed = requestBody;
            if (typeof requestBody === "string")
                parsed = JSON.parse(requestBody);
            const sessionId = this.getSessionId(parsed);
            const session = this.getSession(sessionId);
            const tool = this.getTool(parsed);
            if (tool && session) {
                const data = session.Data;
                if (data) tool.setData(data);
                tool.parseRequest(parsed).then((response) => {
                    if (tool.Data) session.setData(tool.Data);
                    const update = { valid: response.valid, id: tool.Id };
                    if (response.info && response.info.destination) {
                        const assistantId = Object.keys(this.#assistants).find(key => this.#assistants[key].name.includes(response.info.destination));
                        session.createCheckList(parsed, assistantId);
                    }
                    RedisVent.Session.triggerUpsert(SESSION_KEY.UPDATE_CHECKLIST, "session", update);
                    resolve(response);
                }).catch((error) => {
                    resolve({ statusCode: 500, message: error.message || error });
                });
            } else
                resolve({ statusCode: 400, message: "Invalid request!" });
        });
    }
    /**
     * 
     * @param {String} sessionId 
     * @returns {Session}
     */
    getSession(sessionId) {
        return this.#sessions[sessionId];
    }
}

class Session {
    #call;
    #status = "";
    #debounce = null;
    #event;
    #data = null;
    #assistants = {};
    constructor(call, event, assistants) {
        this.#call = call;
        // this.writeStream = fs.createWriteStream(Path.ASSETS + this.SessionId + ".json");
        this.init(call);
        this.#event = event;
        this.#assistants = assistants;
    }
    get SessionId() {
        if (this.IsSquadCall)
            return this.#call.phoneCallProviderId;
        return this.#call.id;
    }
    get Status() {
        return this.#status;
    }
    get Data() {
        return this.#data;
    }
    get IsSquadCall() {
        return !!this.#call.squadId;
    }
    setData(data) {
        this.#data = data;
    }
    init(call) {
        DB.Sessions.insert(call);
    }
    updates(update, forced = false) {
        if (forced) {
            DB.Sessions.update({ id: this.SessionId }, { $set: update });
            return;
        }
        if (this.#debounce) {
            clearTimeout(this.#debounce);
        }
        this.#debounce = setTimeout(Meteor.bindEnvironment(() => {
            DB.Sessions.update({ id: this.SessionId }, { $set: update });
        }), 1000 * 3);
    }
    updateTranscript(transcript) {
        DB.Sessions.update({ id: this.SessionId }, { $push: { transcript } });
    }
    processConversations(conversation = []) {
        return conversation.filter((conv) => {
            return ["bot", "user"].includes(conv.role);
        });
    }
    parseSession(requestBody) {
        let parsed = requestBody;
        if (typeof requestBody === "string")
            parsed = JSON.parse(requestBody);
        const type = parsed.message.type;
        const timestamp = parsed.message.timestamp;
        switch (type) {
            case "status-update":
                this.#status = parsed.message.status;
                if (this.#status === "in-progress") {
                    let assistantId = null;
                    if (this.IsSquadCall) {
                        assistantId = Object.keys(this.#assistants).find(key => this.#assistants[key].name === "Task Router");
                    }
                    this.createCheckList(parsed, assistantId);
                }
                this.updates({ status: this.#status, timestamp });
                RedisVent.Session.triggerUpsert(SESSION_KEY.UPDATE_STATUS, "session", { status: this.#status });
                break;
            case "speech-update":
                this.updates({ status: this.#status, timestamp, speechStatus: parsed.message.status });
                break;
            case "conversation-update":
                const conversation = parsed.message?.artifact?.messages;
                if (conversation && conversation.length) {
                    this.updates({ status: this.#status, timestamp, conversation }, true);
                    RedisVent.Session.triggerUpsert(SESSION_KEY.UPDATE_CONVERSAION, "session", this.processConversations(conversation));
                }
                break;
            case "end-of-call-report":
                this.#status = "completed";
                this.updates({ status: this.#status, timestamp }, true);
                RedisVent.Session.triggerUpsert(SESSION_KEY.UPDATE_STATUS, "session", { status: this.#status });
                this.#event.emit(SESSION_EVENTS.END, this.SessionId);
                break;
        }
    }
    startRecording(body) {
        this.writeStream.write(JSON.stringify(body));
    }
    createCheckList(parsed, id = null) {
        let assistantId = parsed.message?.call?.assistantId;
        if (id) assistantId = id;
        const checklist = [
            {
                name: "Introductions",
                isComplete: true,
                items: [
                    { name: "Greetings", completed: true, current: true, value: "greetings" },
                ]
            },
        ];
        const credentials = {
            name: "Credentials",
            isComplete: false,
            items: []
        };
        if (assistantId) {
            const tools = this.#assistants[assistantId].tools;
            if (tools && tools.length) {
                tools.forEach(tool => {
                    const title = tool.Meta.title;
                    credentials.items.push({ name: title, completed: false, current: false, value: tool.Id });
                });
            }
            checklist.push(credentials);
        }
        Meteor.defer(() => {
            RedisVent.Session.triggerUpsert(SESSION_KEY.UPDATE_STATUS, "session", { status: "started", checklist });
        });
    }
}


