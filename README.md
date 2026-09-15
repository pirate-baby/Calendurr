## Calendurr
_(pronounced Calen-durr)_

**Calendar interfaces suck. All of them.** 
- Life doesn't work in monthly blocks, but that's all calendars can do - so you end up opening up each month and tab-toggling. Gross.
- Things tend to happen over ranges and then inside those ranges: 
    - "Grandma is visiting" goes from Monday until Friday
    - "take Grandma to get cheesesteaks" happens on Tuesday while she is visiting
      
  These shouldn't be events that conflict - one thing is an event, the other is context. 
  Some apps can _sorta_ show this, but not well. 

So this interface solves the things I hate about calendar planning. 

![image of app](assets/calendurr.png)

## Running With TaskWarrior

Calendurr is a web UI backed by the local TaskWarrior client. Start it on the machine that has TaskWarrior configured:

```sh
python3 server.py
```

Then open `http://127.0.0.1:8787`. The Python server serves the UI and translates its generic task model to TaskWarrior commands. TaskWarrior remains responsible for syncing with Taskserver, including its server, credentials, and certificates.

The server binds to localhost deliberately. For remote access, put it behind an authenticated HTTPS reverse proxy rather than exposing the TaskWarrior API directly.

The integration defines two TaskWarrior UDAs, `calendurr_description` and `calendurr_priority_order`, to preserve Calendurr's task description and within-day ordering.

### Task Model

Tasks use a deliberately small, tool-agnostic shape and must have a date:

```js
{
  id: 'T123456',
  title: 'Take Grandma to get cheesesteaks',
  description: 'Meet at 12:30.',
  date: '2026-09-08',
  labels: ['family', 'errand'],
  project: 'Grandma visit',
  priorityOrder: 0,
  status: 'todo'
}
```

`id` is an opaque identifier. `priorityOrder` sorts tasks that share a date. A task with `status: 'done'` is complete; all other values are treated as open. Tasks without a `date` are not stored or displayed.

## OK So What Will You Do With It? 
I am thinking of extending this as a view around TaskWarrior so you can see and manipulate tasks in a calendar-first interface. Or make the interface tool agnostic with adapters for each tool you might want to use (or more than one). 

## What's Up With The Weather
Lots of things in life depend on the weather, yet another thing that is difficult to get visually on most calendar apps. In this case it is baked in.
