import { FuncTemplate } from "./template";
import { Consumer } from "../../../DB";

class OTP extends FuncTemplate {
    constructor(async, server, messages, func, meta) {
        super(async, server, messages, func, meta);
    }

    verifyRequest(number) {
        const data = this.Data;
        if (data) {
            const consumer = new Consumer(data);
            return consumer.sendOTP();
        }
        return Promise.resolve("no number");
    }

    parseRequest(request) {
        const { number } = request.message.toolCalls[0].function.arguments;
        return this.verifyRequest(number).then((response) => {
            if (response === "no number") {
                this.setResponse(200, {
                    results: [
                        {
                            toolCallId: request.message.toolCalls[0].id,
                            result: "No number found",
                        },
                    ],
                });
            } else {
                this.setResponse(200, {
                    results: [
                        {
                            toolCallId: request.message.toolCalls[0].id,
                            result: "OTP sent",
                        },
                    ],
                });
            }
        }).catch((e) => {
            console.log(e);
            this.setResponse(200, {
                results: [
                    {
                        toolCallId: request.message.toolCalls[0].id,
                        result: "no number",
                    },
                ],
            });
        }).finally(() => this.checkResponse());
    }
}
const otp = {
    type: "function",
    messages: [
        {
            type: "request-start",
            content: "Sending OTP...",
        },
        {
            type: "request-response-delayed",
            content: "Just a second...",
            timingMilliseconds: 2000,
        },
    ],
    function: {
        name: "send_otp",
        parameters: {
            type: "object",
            properties: {
                number: {
                    type: "string",
                },
            },
        },
        description:
            "Send OTP to the number available in the database. If response returns no number, request for a valid mobile number. If response returns success, proceed to the next step.",
    },
    async: false,
    server: {
        url: "https://kind-intensely-herring.ngrok-free.app/card_num",
    },
};
const meta = {
    title: "Last four (4) Card Number/Account Number (if they have it)",
};

export default new OTP(otp.async, otp.server, otp.messages, otp.function, meta);