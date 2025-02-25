/*
 *    Copyright (c) 2022-2024 The Peacock Project
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

import { handleEvent } from "./handleEvent"
import { HandleActionsOptions, TestOptions } from "./types"
import { deepClone, findNamedChild, set } from "./utils"
import { handleArrayLogic } from "./arrayHandling"

/**
 * Recursively evaluate a value or object.
 * If something that isn't a state machine object is passed in, it will be
 * translated where possible (e.g. strings will be attempted to be evaluated
 * into the values they correspond to inside the context object). If the value
 * can't be evaluated, the input will be returned.
 *
 * @param input The state machine or value.
 * @param context The context object.
 * @param options The options.
 * @returns The result of the evaluation.
 */
export function test<Context = Record<string, unknown>>(
    input: any,
    context: Context,
    options?: Partial<TestOptions>,
): boolean | any {
    if (!input) {
        throw new Error("State machine is falsy!")
    }

    if (!context) {
        throw new Error("Context is falsy!")
    }

    const opts = options || {}

    return testWithPath(
        input,
        context,
        {
            findNamedChild: opts.findNamedChild || findNamedChild,
            ...opts,
            _path: "",
            _currentLoopDepth: 0,
            logger: opts.logger || (() => {}),
        },
        "",
    )
}

/**
 * Tiny wrapper function that calls {@link realTest} with a path specified.
 * The benefit of using this is that it's a single, inline call, instead of 4
 * lines per call.
 */
function testWithPath<Context>(
    input: any,
    context: Context,
    options: TestOptions,
    name: string,
) {
    // the top-most call
    const thePath = options._path ? `${options._path}.${name}` : name
    const displayPath = thePath || "(root)"
    options.logger?.("visit", `Visiting ${displayPath}`)
    const result = realTest(input, context, {
        ...options,
        _path: thePath,
    })
    options.logger?.("trace", `${displayPath} evaluated to: ${result}`)
    return result
}

function realTest<Variables>(
    input: any,
    variables: Variables,
    options: TestOptions,
): Variables | boolean {
    const log = options.logger

    if (
        typeof input === "number" ||
        typeof input === "boolean" ||
        input === null ||
        input === undefined
    ) {
        return input
    }

    if (typeof input === "string") {
        return options.findNamedChild(input, variables)
    }

    if (Array.isArray(input)) {
        // @ts-expect-error Type mismatch thing.
        return input.map((val, index) =>
            testWithPath(val, variables, options, `[${index}]`),
        )
    }

    if (typeof input === "object") {
        if (input.$eq) {
            // transform any strings inside these arrays into their intended context values
            if (input.$eq.some((val) => Array.isArray(val))) {
                log("validation", "attempted to compare arrays (can't!)")
                return false
            }

            const res = testWithPath(input.$eq[0], variables, options, "$eq[0]")

            if (res == null) return false

            return (
                // we test for each element because we need to make sure that the value is fixed if it's a variable
                input.$eq.every(
                    (val, index) =>
                        index === 0 ||
                        testWithPath(
                            val,
                            variables,
                            options,
                            `$eq[${index}]`,
                        ) === res,
                )
            )
        }

        if (input.$not) {
            return !testWithPath(input.$not, variables, options, "$not")
        }

        if (input.$and) {
            return input.$and.every((val, index) =>
                testWithPath(val, variables, options, `$and[${index}]`),
            )
        }

        if (input.$or) {
            return input.$or.some((val, index) =>
                testWithPath(val, variables, options, `$or[${index}]`),
            )
        }

        if (input.$gt) {
            return (
                testWithPath(input.$gt[0], variables, options, "$gt[0]") >
                testWithPath(input.$gt[1], variables, options, "$gt[1]")
            )
        }

        if (input.$ge) {
            return (
                testWithPath(input.$ge[0], variables, options, "$ge[0]") >=
                testWithPath(input.$ge[1], variables, options, "$ge[1]")
            )
        }

        if (input.$lt) {
            return (
                testWithPath(input.$lt[0], variables, options, "$lt[0]") <
                testWithPath(input.$lt[1], variables, options, "$lt[1]")
            )
        }

        if (input.$le) {
            return (
                testWithPath(input.$le[0], variables, options, "$le[0]") <=
                testWithPath(input.$le[1], variables, options, "$le[1]")
            )
        }

        if (input.$inarray) {
            return handleArrayLogic(
                testWithPath,
                input,
                variables,
                "$inarray",
                options,
            )
        }

        if (input.$any) {
            return handleArrayLogic(
                testWithPath,
                input,
                variables,
                "$any",
                options,
            )
        }

        if (input.$all) {
            return handleArrayLogic(
                testWithPath,
                input,
                variables,
                "$all",
                options,
            )
        }

        if (input.$after) {
            const path = `${options._path}.$after`

            if (!options.timers) {
                return false
            }

            let timer = options.timers.find((timer) => timer.path === path)

            if (!timer) {
                const seconds = <number>(
                    testWithPath(input.$after, variables, options, "$after")
                )

                // zero is falsy, hence the extra check
                if (!options.eventTimestamp && options.eventTimestamp !== 0) {
                    log(
                        "validation",
                        "No event timestamp found when timer is supposed to be active",
                    )
                    return false
                }

                timer = {
                    startTime: options.eventTimestamp,
                    endTime: options.eventTimestamp + seconds,
                    path,
                }

                options.timers.push(timer)
            }

            log("eventStamp", String(options.eventTimestamp))
            log("endTime", String(timer.endTime))

            if (options.eventTimestamp >= timer.endTime) {
                // The timer is up. Delete it from the timers array
                // so that a new timer can be created if this state is visited again.
                const index = options.timers.findIndex(
                    (timer) => timer.path === path,
                )

                if (index !== -1) {
                    options.timers.splice(index, 1)
                }

                return true
            }

            return false
        }

        if (input.$pushunique) {
            return options.pushUniqueAction?.(
                input.$pushunique[0],
                testWithPath(
                    input.$pushunique[1],
                    variables,
                    options,
                    "$pushunique[1]",
                ),
            )
        }

        if (input.$contains) {
            const first = testWithPath(
                input.$contains[0],
                variables,
                options,
                "$contains[0]",
            )
            const second = testWithPath(
                input.$contains[1],
                variables,
                options,
                "$contains[1]",
            )

            if (typeof first === "string") {
                return first.includes(second as string)
            }

            return false
        }
    }

    log("unhandled", `Unhandled test: '${input}'`)

    return false
}

/**
 * @internal
 */
export type TestWithPathFunc = typeof testWithPath

/**
 * Handles a group of action nodes (a.k.a. side-effect nodes).
 * Actions will modify the context, which will then be returned.
 *
 * @param input The actions to take.
 * @param context The context.
 * @param options The options.
 * @returns The modified context.
 * @example
 *  let context = { Number: 8 }
 *  const actions = {
 *      // increment the value of Number by 1
 *      $inc: "$Number",
 *  }
 *  context = handleActions(actions, context)
 *  // context will now be { Number: 9 }
 */
export function handleActions<Context>(
    input: any,
    context: Context,
    options?: HandleActionsOptions,
): Context {
    if (!input || typeof input !== "object") {
        return context
    }

    const addOrDec = (op: string) => {
        if (typeof input[op] === "string") {
            let reference = input[op]

            const variableValue = findNamedChild(input[op], context, true)

            if (typeof variableValue !== "number") {
                return
            }

            set(
                context,
                reference,
                op === "$inc" ? variableValue + 1 : variableValue - 1,
            )
        } else {
            let reference = input[op][0]

            const variableValue = findNamedChild(reference, context, true)
            const incrementBy = findNamedChild(input[op][1], context, false)

            if (typeof variableValue !== "number") {
                return
            }

            set(
                context,
                reference,
                op === "$inc"
                    ? variableValue + incrementBy
                    : variableValue - incrementBy,
            )
        }
    }

    const push = (unique: boolean): void => {
        const op = unique ? "$pushunique" : "$push"
        let reference = input[op][0]

        if (reference.startsWith("$")) {
            reference = reference.substring(1)
        }

        const value = findNamedChild(input[op][1], context, false)

        // clone the thing
        const array = deepClone(findNamedChild(reference, context, true))

        if (!Array.isArray(array)) {
            return
        }

        if (unique) {
            if (array.indexOf(value) === -1) {
                array.push(value)
            } else {
                return
            }
        } else {
            array.push(value)
        }

        set(context, reference, array)
    }

    for (const key of Object.keys(input)) {
        switch (key) {
            case "$inc": {
                addOrDec("$inc")
                break
            }
            case "$dec": {
                addOrDec("$dec")
                break
            }
            case "$mul": {
                // $mul can have 2 or 3 operands, 2 means multiply the context variable (1st operand) by the 2nd operand
                let reference =
                    input["$mul"][input["$mul"].length === 3 ? 2 : 0]

                // Therefore the 1st operand might get written to, but the 2nd one is purely a read.
                const variableValue1 = findNamedChild(
                    input["$mul"][0],
                    context,
                    true,
                )
                const variableValue2 = findNamedChild(
                    input["$mul"][1],
                    context,
                    false,
                )

                if (
                    typeof variableValue1 !== "number" ||
                    typeof variableValue2 !== "number"
                ) {
                    break
                }

                set(context, reference, variableValue1 * variableValue2)
                break
            }
            case "$set": {
                let reference = input.$set[0]

                const value = findNamedChild(input.$set[1], context, false)

                set(context, reference, value)
                break
            }
            case "$push": {
                push(false)
                break
            }
            case "$pushunique": {
                push(true)
                break
            }
            case "$remove": {
                let reference = input.$remove[0]

                if (reference.startsWith("$")) {
                    reference = reference.substring(1)
                }

                const value = findNamedChild(input.$remove[1], context, false)

                // clone the thing
                let array: unknown[] = deepClone(
                    findNamedChild(reference, context, true),
                )

                if (!Array.isArray(array)) {
                    break
                }

                array = array.filter((item) => item !== value)

                set(context, reference, array)
                break
            }
            case "$reset": {
                let reference = input.$reset
                const value = findNamedChild(
                    reference,
                    options.originalContext,
                    true,
                )

                set(context, reference, value)
                break
            }
        }
    }

    return context
}

export { handleEvent }
export * from "./types"
