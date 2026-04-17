// deno-lint-ignore-file no-explicit-any ban-types
import util from 'node:util';
export enum LoggingLevel {
	debug = 0,
	info = 1,
	warn = 2,
	error = 3,
	critical = 4,
}
/**
 * logging class
 */
export default class Logger {
	private logging_function?: Function;
	log_level: LoggingLevel = LoggingLevel.debug;
	readonly prefixes: Map<LoggingLevel, string> = new Map([
		[LoggingLevel.debug, '[DBG]'],
		[LoggingLevel.info, '[INFO]'],
		[LoggingLevel.warn, '[WARN]'],
		[LoggingLevel.error, '[ERR]'],
		[LoggingLevel.critical, '[CRIT]'],
	])
	attach(logging_function: Function) {
		this.logging_function = logging_function;
	}
	detach() {
		this.logging_function = undefined;
	}
	_log(level: LoggingLevel, data: string): void {
		if (this.log_level > level)
			return;
		const prefix = this.prefixes.get(level);
		if (!prefix)
			throw new Error('invalid state');
		const log = `${prefix}\t${data}`;
		if (!this.logging_function)
			return;
		this.logging_function(log)
	}
	stringify_log(log: any[]): string {
		return log
			.map(el => typeof el === 'string' ? el : util.inspect(el))
			.join(' ')
	}
	info(...elements: any[]) {
		this._log(LoggingLevel.info, this.stringify_log(elements))
	}
	debug(...elements: any[]) {
		this._log(LoggingLevel.debug, this.stringify_log(elements))
	}
	error(...elements: any[]) {
		this._log(LoggingLevel.error, this.stringify_log(elements))
	}
	log_critical(...elements: any[]) {
		this._log(LoggingLevel.critical, this.stringify_log(elements))
	}
	warn(...elements: any[]) {
		this._log(LoggingLevel.warn, this.stringify_log(elements))
	}
}