import type { Connection, ContainerOptions, Dictionary, EventContext } from 'rhea';
import { create_container } from 'rhea';

import type {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ICredentialTestFunctions,
	INodeCredentialTestResult,
	ICredentialsDecrypted,
	ICredentialDataDecryptedObject,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

export class Amqp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AMQP Sender',
		name: 'amqp',
		// eslint-disable-next-line n8n-nodes-base/node-class-description-icon-not-svg
		icon: 'file:amqp.svg',
		group: ['transform'],
		version: 1,
		description: 'Sends a raw-message via AMQP 1.0, executed once per item',
		defaults: {
			name: 'AMQP Sender',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'amqp',
				required: true,
				testedBy: 'amqpConnectionTest',
			},
		],
		properties: [
			{
				displayName: 'Queue / Topic',
				name: 'sink',
				type: 'string',
				default: '',
				placeholder: 'topic://sourcename.something',
				description: 'Name of the queue of topic to publish to',
			},
			// Header Parameters
			{
				displayName: 'Headers',
				name: 'headerParametersJson',
				type: 'json',
				default: '',
				description:
					'Header parameters as JSON (flat object). Sent as application_properties in amqp-message meta info.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Container ID',
						name: 'containerId',
						type: 'string',
						default: '',
						description: 'Will be used to pass to the RHEA Backend as container_id',
					},
					{
						displayName: 'Data as Object',
						name: 'dataAsObject',
						type: 'boolean',
						default: false,
						description: 'Whether to send the data as an object',
					},
					{
						displayName: 'Reconnect',
						name: 'reconnect',
						type: 'boolean',
						default: true,
						description: 'Whether to automatically reconnect if disconnected',
					},
					{
						displayName: 'Reconnect Limit',
						name: 'reconnectLimit',
						type: 'number',
						default: 50,
						description: 'Maximum number of reconnect attempts',
					},
					{
						displayName: 'Send Property',
						name: 'sendOnlyProperty',
						type: 'string',
						default: '',
						description: 'The only property to send. If empty the whole item will be sent.',
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			async amqpConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const credentials = credential.data as ICredentialDataDecryptedObject;
				const connectOptions: ContainerOptions = {
					reconnect: false,
					host: credentials.hostname as string,
					hostname: credentials.hostname as string,
					port: credentials.port as number,
					username: credentials.username ? (credentials.username as string) : undefined,
					password: credentials.password ? (credentials.password as string) : undefined,
					transport: credentials.transportType ? (credentials.transportType as string) : undefined,
				};

				let conn: Connection | undefined = undefined;
				try {
					const container = create_container();
					await new Promise<void>((resolve, reject) => {
						container.on('connection_open', function (_contex: EventContext) {
							resolve();
						});
						container.on('disconnected', function (context: EventContext) {
							reject(context.error ?? new Error('unknown error'));
						});
						conn = container.connect(connectOptions);
					});
				} catch (error) {
					return {
						status: 'Error',
						message: (error as Error).message,
					};
				} finally {
					if (conn) (conn as Connection).close();
				}

				return {
					status: 'OK',
					message: 'Connection successful!',
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		try {
			const credentials = await this.getCredentials('amqp');

			const sink = this.getNodeParameter('sink', 0, '') as string;
			const applicationProperties = this.getNodeParameter('headerParametersJson', 0, {}) as
				| string
				| object;
			const options = this.getNodeParameter('options', 0, {});
			const containerId = options.containerId as string;
			const containerReconnect = (options.reconnect as boolean) || true;
			const containerReconnectLimit = (options.reconnectLimit as number) || 50;

			let headerProperties: Dictionary<any>;
			if (typeof applicationProperties === 'string' && applicationProperties !== '') {
				headerProperties = JSON.parse(applicationProperties);
			} else {
				headerProperties = applicationProperties as object;
			}

			if (sink === '') {
				throw new NodeOperationError(this.getNode(), 'Queue or Topic required!');
			}

			const container = create_container();

			/*
				Values are documentet here: https://github.com/amqp/rhea#container
			*/
			const connectOptions: ContainerOptions = {
				host: credentials.hostname,
				hostname: credentials.hostname,
				port: credentials.port,
				reconnect: containerReconnect,
				reconnect_limit: containerReconnectLimit,
				username: credentials.username ? credentials.username : undefined,
				password: credentials.password ? credentials.password : undefined,
				transport: credentials.transportType ? credentials.transportType : undefined,
				container_id: containerId ? containerId : undefined,
				id: containerId ? containerId : undefined,
			};
			const conn = container.connect(connectOptions);

			const sender = conn.open_sender(sink);

			const responseData: IDataObject[] = await new Promise((resolve) => {
				container.once('sendable', (context: EventContext) => {
					const returnData = [];

					const items = this.getInputData();
					for (let i = 0; i < items.length; i++) {
						const item = items[i];

						let body: IDataObject | string = item.json;
						const sendOnlyProperty = options.sendOnlyProperty as string;

						if (sendOnlyProperty) {
							body = body[sendOnlyProperty] as string;
						}

						if (options.dataAsObject !== true) {
							body = JSON.stringify(body);
						}

						const result = context.sender?.send({
							application_properties: headerProperties,
							body,
						});

						returnData.push({ id: result?.id });
					}

					resolve(returnData);
				});
			});

			sender.close();
			conn.close();

			return [this.helpers.returnJsonArray(responseData)];
		} catch (error) {
			if (this.continueOnFail(error)) {
				return [this.helpers.returnJsonArray({ error: error.message })];
			} else {
				throw error;
			}
		}
	}
}
