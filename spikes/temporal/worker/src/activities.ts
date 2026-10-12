import { Context } from '@temporalio/activity';

export async function stamp(what: string): Promise<string> {
  return `${what} (attempt ${Context.current().info.attempt}, pid ${process.pid})`;
}
